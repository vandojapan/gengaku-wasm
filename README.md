# EasyRPG Web Launcher

React + Vite で作った EasyRPG Web ランチャーです。ゲーム本体は同梱せず、ユーザーがローカルで選択した ZIP を File API で受け取り、JSZip でブラウザ内展開します。ZIP はサーバーに送信しません。

## 開発

```bash
npm install
npm run dev
```

## WASM 本体の配置

EasyRPG/WASM 本体は後から差し替えられるよう、以下の public ファイルとして扱います。

```text
public/easyrpg-player.js
public/easyrpg-player.wasm
```

今回のように公式Web出力が `public/index.js` / `public/index.wasm` の場合も自動検出します。

未配置の場合も UI、ZIP選択、JSZip展開、仮想ゲームパッドの確認はできます。起動時は「WASM本体待ち」を表示します。

## public 配下のゲームで起動

`public/games/GengakuSyoujo_WF` がある場合は、画面の「publicゲーム」ボタンから `games/GengakuSyoujo_WF` を EasyRPG に渡して起動できます。

## ゲームZIPの扱い

1. ユーザーがブラウザでローカル ZIP を選択します。
2. `src/easyrpgBridge.js` の `readGameZip()` が File API と JSZip でブラウザ内展開します。
3. EasyRPG を `noInitialRun` で初期化します。
4. 展開済みファイルを Emscripten FS の `/game` に `writeFile()` します。
5. `_main()` に `/game` を渡して起動します。

表示する注意文:

> ゲーム本体は配布していません。正規に入手したZIPを選択してください。ファイルはブラウザ内で処理され、サーバーには送信されません。

## 入力

仮想ゲームパッドの入力は `KeyboardEvent` として `window` と `document` に dispatch します。

| 操作 | キー |
| --- | --- |
| Up | ArrowUp |
| Down | ArrowDown |
| Left | ArrowLeft |
| Right | ArrowRight |
| A | K |
| B | X |
| START | Z |

## 構成

- `src/App.jsx`: ZIP選択、注意文、起動ボタン、canvas、全画面、パッド表示切替
- `src/VirtualGamepad.jsx`: スライド式十字キー、A/B/START、タッチと pointer events
- `src/easyrpgBridge.js`: WASM検出、JSZip展開、Emscripten FS `/game` 配置、EasyRPG Module 接続
- `src/styles.css`: ランチャーとプレイヤーUI

EasyRPG 本体のコードはこのリポジトリでは編集しません。

## Runtime event hook

The frontend listens for EasyRPG runtime events without touching the EasyRPG core.
When the runtime side can emit an event, dispatch this from JS glue code:

```js
window.dispatchEvent(new CustomEvent('easyrpg:event', {
  detail: { name: 'show-button', label: 'EVENT' },
}));
```

For quick checks before the WASM side is wired, run this in DevTools:

```js
window.easyRpgEventBridge.emit({ name: 'show-button', label: 'EVENT' });
```

If the runtime prints `SHOW_EVENT_BUTTON` to stdout/stderr, the bridge also detects it and shows the same button.

Test rule for Gengakushoujo:

```js
window.easyRpgEventBridge.emit({
  mapName: 'Map0005',
  button: 'A',
});
```

The `Map0004` button is always visible for verification. The event hook can still update the same button state. If the runtime emits only the current map first, the frontend also detects the real A key event:

```js
window.easyRpgEventBridge.emit({ mapName: 'Map0005' });
```

Pressing the `Map0004` button dispatches `easyrpg:jump-request` with `{ mapId: 4, mapName: 'Map0004' }`; if a compatible EasyRPG map jump API is exposed later, the bridge will call it.
