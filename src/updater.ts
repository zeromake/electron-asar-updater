import {spawn} from 'node:child_process';
import {platform} from 'node:process';
import path from 'node:path';
import uitls from 'node:util';
import {Stream, Writable} from 'node:stream';
import {createGunzip} from 'node:zlib';
import http from 'node:http';
import {app} from 'electron';
import {rm, createWriteStream, access, rename, writeFile, readFile} from 'fs';

const rmPromisify = uitls.promisify(rm);
const renamePromisify = uitls.promisify(rename);
const accessPromisify = uitls.promisify(access);
const writeFilePromisify = uitls.promisify(writeFile);
const readFilePromisify = uitls.promisify(readFile);

const asarSwapFileName = 'swap.asar';
const asarTmpFileName = 'next.asar';
const asarVersionFileName = 'version.json';
const asarTargetFileName = 'app.asar';
const _appPath = app.getAppPath();
const lastIndex = _appPath.lastIndexOf(asarTargetFileName);
const appPathFolder = _appPath.slice(0, lastIndex === -1 ? _appPath.length : lastIndex);
const asarTmpPath = path.join(appPathFolder, asarTmpFileName);
const asarSwapPath = path.join(appPathFolder, asarSwapFileName);
const asarTargetPath = path.join(appPathFolder, asarTargetFileName);
const asarVersionPath = path.join(appPathFolder, asarVersionFileName);
const resourcePath = path.relative(path.resolve('.'), appPathFolder);

async function exists(path: string, mode?: number) {
  try {
    await accessPromisify(path, mode);
    return true;
  } catch (err) {
    return false;
  }
}

function parserVersion(ver: string) {
  let build = 0;
  if (ver.includes('-')) {
    let buildstr = '0';
    [ver, buildstr] = ver.split('-');
    build = parseInt(buildstr, 10);
  }
  const [major, minor, revision = 0] = ver.split('.').map(item => parseInt(item));
  return {
    major,
    minor,
    revision,
    build,
  };
}

function pipe(stream: Stream, ...streams: Writable[]): Promise<void> {
  return new Promise(function (resolve, reject) {
    stream.on('error', reject);
    for (const nextStream of streams) {
      stream = stream.pipe(nextStream);
      stream.on('error', reject);
    }
    stream.on('finish', resolve);
  });
}

const headers = {UserAgent: '@zeromake/electron-asar-updater/1.0.0'}

function http_get_json<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    http.get(url, {headers}, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Failed to fetch ${url}: ${res.statusCode}`));
      }
      res.setEncoding('utf8');
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

function http_get_stream(url: string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    http.get(url, {headers}, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Failed to fetch ${url}: ${res.statusCode}`));
      }
      resolve(res);
    }).on('error', reject);
  });
}

export class AsarUpdater {
  private checkVersionUrl: string;
  private downloadHost: string;

  constructor(checkVersionUrl: string) {
    this.checkVersionUrl = checkVersionUrl;
    this.downloadHost = new URL(checkVersionUrl).origin;
  }

  async checkUpdates(
    curentVersion: string,
  ): Promise<{version: string; updater: boolean; download_url: string}> {
    const data = await http_get_json<{
      version: string;
      download_url: string;
    }>(this.checkVersionUrl)
    const isUpdater = this.compareVersions(data.version, curentVersion);
    let downloadUrl = '';
    if (!data.download_url.startsWith('http://') && !data.download_url.startsWith('https://')) {
      downloadUrl = `${this.downloadHost}${data.download_url.startsWith('/') ? '' : '/'}${
        data.download_url
      }`;
    } else {
      downloadUrl = data.download_url;
    }
    return {
      ...data,
      updater: isUpdater,
      download_url: downloadUrl,
    };
  }

  compareVersions(updateVersionStr: string, currentVersionStr: string) {
    const appVersion = parserVersion(currentVersionStr);
    const updateVersion = parserVersion(updateVersionStr);
    if (updateVersion.major !== appVersion.major) return updateVersion.major > appVersion.major;
    if (updateVersion.minor !== appVersion.minor) return updateVersion.minor > appVersion.minor;
    if (updateVersion.revision !== appVersion.revision)
      return updateVersion.revision > appVersion.revision;
    if (updateVersion.build !== appVersion.build) return updateVersion.build > appVersion.build;
    return false;
  }

  async generateWinScript(scriptPath: string, relaunch: boolean = true) {
    const execPath = 'slots-config-gui.exe';
    if (!(await exists(path.join('.', execPath)))) {
      relaunch = false;
    }
    await writeFilePromisify(
      scriptPath,
      `
On Error Resume Next
Set wshShell = WScript.CreateObject("WScript.Shell")
Set fsObject = WScript.CreateObject("Scripting.FileSystemObject")
updaterPath = "${path.join(resourcePath, asarTmpFileName)}"
destPath = "${path.join(resourcePath, asarTargetFileName)}"

Do While fsObject.FileExists(destPath)
  fsObject.DeleteFile destPath
  WScript.Sleep 250
Loop

WScript.Sleep 250
fsObject.MoveFile updaterPath,destPath
WScript.Sleep 250

${relaunch ? 'wshShell.Run ".\\' + execPath + '"' : ''}
`,
      {encoding: 'utf8'},
    );
  }

  async download(asarInfo: {download_url: string; version: string}) {
    if (await exists(asarSwapPath)) {
      await rmPromisify(asarSwapPath, {force: true});
    }
    if (await exists(asarVersionPath)) {
      await rmPromisify(asarVersionPath, {force: true});
    }
    const {download_url} = asarInfo;
    const inStream = await http_get_stream(download_url);
    const isGzip = download_url.endsWith('.gz') || download_url.endsWith('.gzip');
    // 使用交换文件路径防止出现文件中断导致文件损坏
    const outStream = createWriteStream(asarSwapPath, {encoding: 'binary', flags: 'w'});
    if (isGzip) {
      await pipe(inStream, createGunzip(), outStream);
    } else {
      await pipe(inStream, outStream);
    }
    await renamePromisify(asarSwapPath, asarTmpPath);
    await writeFilePromisify(asarVersionPath, JSON.stringify(asarInfo, null, 2), {
      encoding: 'utf8',
    });
    return true;
  }

  async hasUpgradeFile() {
    if ((await exists(asarTmpPath)) && (await exists(asarVersionPath))) {
      return JSON.parse(await readFilePromisify(asarVersionPath, {encoding: 'utf8'}));
    }
    return null;
  }

  async upgrade(relaunch = true, exit = true) {
    const nextAsar = await exists(asarTmpPath);
    if (nextAsar) {
      // 清理掉 worker js 文件
      const workerPath = path.join(appPathFolder, 'workers');
      if (await exists(workerPath)) {
        await rmPromisify(workerPath, {force: true});
      }
      switch (platform) {
        case 'win32':
          {
            const updaterScriptPath = path.join(resourcePath, 'updater.vbs');
            await this.generateWinScript(updaterScriptPath, relaunch);
            spawn('cmd', ['/s', '/c', 'wscript', `"${updaterScriptPath}"`], {
              detached: true,
              windowsVerbatimArguments: true,
              stdio: 'ignore',
              windowsHide: true,
            });
          }
          if (exit) {
            setTimeout(() => {
              app.exit();
            }, 100);
          }
          break;
        default:
          {
            await rmPromisify(asarTargetPath, {force: true});
            await renamePromisify(asarTmpPath, asarTargetPath);
            if (relaunch) {
              app.relaunch();
            }
            if (exit) {
              app.exit();
            }
          }
          break;
      }
    }
  }
}
