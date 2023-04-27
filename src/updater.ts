import {spawn} from 'node:child_process';
import {platform} from 'node:process';
import {join, relative, resolve, sep} from 'node:path';
import {promisify} from 'node:util';
import {Stream, Writable} from 'node:stream';
import {createGunzip} from 'node:zlib';
import {request as httpsRequest} from 'node:https';
import {request as httpRequest} from 'node:http';
import {rm, createWriteStream, access, rename, writeFile, readFile} from 'fs';

const rmPromisify = promisify(rm);
const renamePromisify = promisify(rename);
const accessPromisify = promisify(access);
const writeFilePromisify = promisify(writeFile);
const readFilePromisify = promisify(readFile);

const asarSwapFileName = 'swap.asar';
const asarNextFileName = 'next.asar';
const asarVersionFileName = 'version.json';
const asarTargetFileName = 'app.asar';

async function exists(p: string, mode?: number) {
  try {
    await accessPromisify(p, mode);
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
  const [major, minor, patch = 0] = ver.split('.').map(item => parseInt(item, 10));
  return [major, minor, patch, build];
}

function compareVersions(updateVersionStr: string, currentVersionStr: string) {
  const appVersion = parserVersion(currentVersionStr);
  const updateVersion = parserVersion(updateVersionStr);
  for (let i = 0; i < 4; i++) {
    if (updateVersion[i] !== appVersion[i]) return updateVersion[i] > appVersion[i];
  }
  return false;
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

const headers = {'user-agent': '@zeromake/electron-asar-updater/1.0.0'};

function http_get_json<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https://') ? httpsRequest : httpRequest)(
      url,
      {headers, timeout: 5000, method: 'GET'},
      res => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Failed to fetch ${url}: ${res.statusCode}`));
        }
        res.setEncoding('utf8');
        let data = '';
        res.on('data', chunk => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      },
    ).on('error', reject);
    req.end();
  });
}

function http_get_stream(url: string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https://') ? httpsRequest : httpRequest)(
      url,
      {headers, method: 'GET'},
      res => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Failed to fetch ${url}: ${res.statusCode}`));
        }
        resolve(res);
      },
    ).on('error', reject);
    req.end();
  });
}

async function generateWinScript(resourcePath: string, scriptPath: string, execPath?: string) {
  let relaunch = false;
  if (execPath) {
    execPath = relative(resolve('.'), execPath);
  }
  if (execPath && (await exists(join('.', execPath)))) {
    relaunch = true;
  }
  await writeFilePromisify(
    scriptPath,
    `
On Error Resume Next
Set wshShell = WScript.CreateObject("WScript.Shell")
Set fsObject = WScript.CreateObject("Scripting.FileSystemObject")
updaterPath = "${join(resourcePath, asarNextFileName)}"
destPath = "${join(resourcePath, asarTargetFileName)}"

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

export interface AsarInfoResponse {
  /**
   * 远端版本号格式：${major}.${minor}.${patch}[-${build}]，示例 1.0.0-1
   */
  version: string;
  /**
   * asar 下载地址，gz|gzip 后缀结尾会自动解压，如果不以 http，https 开头会拼接当前地址
   */
  download_url: string;
  /**
   * 更新说明文本
   */
  description?: string;
  /**
   * 下载的文件需要进行校验，仅支持 gzip 解压后的文件校验
   */
  checksum?: string;
}

export interface AsarUpdaterOptions {
  /**
   * 检查更新的 http 地址
   */
  version_url: string;
  /**
   * asar 所在目录
   */
  resource_path: string;
}

export class AsarUpdater {
  /**
   * 检查版本号的接口地址
   */
  private readonly checkVersionUrl: string;
  /**
   * 检查版本号的接口地址
   */
  private readonly downloadHost: string;

  private readonly appPathFolder: string;
  private readonly asarNextPath: string;
  private readonly asarSwapPath: string;
  private readonly asarTargetPath: string;
  private readonly asarVersionPath: string;
  private readonly resourcePath: string;

  /**
   * @param options 选项
   */
  public constructor(options: AsarUpdaterOptions) {
    this.checkVersionUrl = options.version_url;
    this.downloadHost = new URL(options.version_url).origin;
    const resource_path = options.resource_path.endsWith(asarTargetFileName)
      ? options.resource_path.slice(0, -asarTargetFileName.length)
      : options.resource_path;
    this.appPathFolder = resource_path.endsWith(sep) ? resource_path.slice(0, -1) : resource_path;
    this.asarNextPath = join(this.appPathFolder, asarNextFileName);
    this.asarSwapPath = join(this.appPathFolder, asarSwapFileName);
    this.asarTargetPath = join(this.appPathFolder, asarTargetFileName);
    this.asarVersionPath = join(this.appPathFolder, asarVersionFileName);
    this.resourcePath = relative(resolve('.'), this.appPathFolder);
  }

  /**
   * 检查是否有更新
   * @param curentVersion 当前软件版本号
   * @returns [是否需要更新,文件信息]
   */
  public async check(curentVersion: string): Promise<[boolean, Readonly<AsarInfoResponse>]> {
    const data = await http_get_json<AsarInfoResponse>(this.checkVersionUrl);
    let isUpdater = compareVersions(data.version, curentVersion);
    let downloadUrl = '';
    if (!data.download_url.startsWith('http://') && !data.download_url.startsWith('https://')) {
      if (!data.download_url.startsWith('/')) {
        downloadUrl = `${this.checkVersionUrl.slice(0, this.checkVersionUrl.lastIndexOf('/'))}/${
          data.download_url
        }`;
      } else {
        downloadUrl = `${this.downloadHost}${data.download_url}`;
      }
    } else {
      downloadUrl = data.download_url;
    }
    // 如果上一次更新信息还在，检查一下是否无限更新了
    if (await exists(this.asarVersionPath)) {
      const nextUpdaterInfo = JSON.parse(
        await readFilePromisify(this.asarVersionPath, {encoding: 'utf8'}),
      ) as Readonly<AsarInfoResponse>;
      if (nextUpdaterInfo.checksum && nextUpdaterInfo.checksum === data.checksum) {
        isUpdater = false;
      }
    }
    return [
      isUpdater,
      {
        ...data,
        download_url: downloadUrl,
      },
    ];
  }

  /**
   * 下载asar
   * @param asarInfo asar信息
   */
  public async download(asarInfo: Readonly<AsarInfoResponse>) {
    for (const file of [this.asarSwapPath, this.asarVersionPath]) {
      if (await exists(file)) {
        await rmPromisify(file);
      }
    }
    const {download_url} = asarInfo;
    const inStream = await http_get_stream(download_url);
    const isGzip = download_url.endsWith('.gz') || download_url.endsWith('.gzip');
    // 使用交换文件路径防止出现文件中断导致文件损坏
    const outStream = createWriteStream(this.asarSwapPath, {encoding: 'binary', flags: 'w'});
    if (isGzip) {
      await pipe(inStream, createGunzip(), outStream);
    } else {
      await pipe(inStream, outStream);
    }
    // Todo: 做文件校验
    // 重命名文件
    await renamePromisify(this.asarSwapPath, this.asarNextPath);
    // 写入这次更新信息
    await writeFilePromisify(this.asarVersionPath, JSON.stringify(asarInfo, null, 2), {
      encoding: 'utf8',
    });
    return true;
  }

  /**
   * 软件当前是否已经有 asar 的更新文件
   */
  public async hasUpgraded(): Promise<boolean | Readonly<AsarInfoResponse>> {
    if ((await exists(this.asarNextPath)) && (await exists(this.asarVersionPath))) {
      return JSON.parse(
        await readFilePromisify(this.asarVersionPath, {encoding: 'utf8'}),
      ) as Readonly<AsarInfoResponse>;
    }
    return false;
  }

  /**
   * 替换 asar 文件
   * @param execPath win32 传入可以触发重启(其它平台请自行使用 app.relaunch)
   */
  public async upgrade(execPath?: string): Promise<void> {
    if (platform === 'win32') {
      const updaterScriptPath = join(this.resourcePath, 'updater.vbs');
      await generateWinScript(this.resourcePath, updaterScriptPath, execPath);
      spawn('cmd', ['/s', '/c', 'wscript', `"${updaterScriptPath}"`], {
        detached: true,
        windowsVerbatimArguments: true,
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      await rmPromisify(this.asarTargetPath, {force: true});
      await renamePromisify(this.asarNextPath, this.asarTargetPath);
    }
  }
}
