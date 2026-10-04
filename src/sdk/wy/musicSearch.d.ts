// wy 搜索模块的类型声明。
//
// 各平台 `.js` 是原样移植的，TypeScript 要求声明文件与 `.js` **同目录同名**才能配对，
// 所以这里只做转发 —— 类型本体只有一份：../musicSearch.d.ts。
export type { SdkMusicItem, SdkSearchResult } from '../musicSearch.d'
export { default } from '../musicSearch.d'
