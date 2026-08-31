import { readFile, writeFile } from "node:fs/promises";

const vendorUrl = new URL("../dist/build/mp-weixin/common/vendor.js", import.meta.url);
const source = await readFile(vendorUrl, "utf8");
const callIndex = source.indexOf("wx.preloadAssets");
const start = source.lastIndexOf(";!function(){", callIndex);
const endMarker = "}}(),";
const end = source.indexOf(endMarker, callIndex);
const block = start >= 0 && end >= 0 ? source.slice(start, end + endMarker.length) : "";
const callCount = block.match(/wx\.preloadAssets/g)?.length ?? 0;

// DCloud 的生产运行时会自动预取 CDN 阴影图，且当前没有关闭开关：
// https://github.com/dcloudio/uni-app/issues/1803
if (!block.includes("shadow-grey.png") || callCount !== 2) {
  throw new Error("未找到预期的 DCloud 阴影图预加载代码，拒绝生成可能联网的公开 Demo");
}

await writeFile(vendorUrl, `${source.slice(0, start)};${source.slice(end + endMarker.length)}`, "utf8");
