# @zeromake/electron-asar-updater

electron 的 asar 更新器，无第三方依赖，仅依赖 `node` 内置库，`fs` 到 `original-fs` 替换使用 `vite` 的 `alias` 处理。

## 使用

electron main

```ts
import {app, BrowserWindow} from 'electron';
import {join} from 'node:path';
import {execPath} from 'node:process';

const asarUpdater = new AsarUpdater(import.meta.env.VITE_UPDATER_URL, app.getAppPath());

async function upgradeAsarFile(relaunch: boolean) {
    // 有更新文件就进行替换逻辑
    if (await asarUpdater.hasUpgraded()) {
        await asarUpdater.upgrade(relaunch ? execPath : undefined);
        if (relaunch && process.platform !== 'win32') {
            app.relaunch();
        }
    }
    app.exit();
};

function getVersion() {
  return import.meta.env.VITE_APP_VERSION || app.getVersion();
}

async function createWindow() {
    const browserWindow = new BrowserWindow({
        show: false,
    });

    if (!import.meta.env.DEV) {
        // 主窗口关闭时尝试替换 asar 文件
        browserWindow.on('close', function(event) {
            event.preventDefault();
            upgradeAsarFile(true);
        });
    }

    browserWindow.once('ready-to-show', async function() {
        browserWindow.show();
        if (!import.meta.env.DEV) {
            const [isUpdater, asarInfo] = await asarUpdater.check(getVersion());
            if (isUpdater) {
                // TODO 通知进行更新
                if (await asarUpdater.download(asarInfo)) {
                    // TODO 通知需要重启，用户确认
                    await upgradeAsarFile(true);
                } else {
                    // TODO 通知下载更新文件失败
                }
            }
        }
    });
}
```
