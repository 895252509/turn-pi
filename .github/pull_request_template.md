## 这个 PR 做了什么

<!-- 一句话说清；如果是修 bug，先说清 bug 是什么 -->

## 为什么这么做

<!-- 有没有别的打法？为什么选这个？有取舍就写出来 -->

## 怎么验的

<!-- 勾上你实际跑过的；没跑的都说明一下 -->

- [ ] `make check`（server 语法 + 搜索/抓取离线回归）
- [ ] `make check-web`（tsc + 构建 + happy-dom 冒烟）
- [ ] 相关模块自检：`npm run check:agent-card` / `check:agent-spec` / `check:mcp` / `check:git-panel` / `check:worktree-deps` / `check:workspace-tools`
- [ ] 手工点过：<!-- 哪几个界面 / 哪条链路 -->

## 影响面

- [ ] 改了 `/api` 形状（前端与后端要同时改，`check-routes` 已过）
- [ ] 改了 `runtime/` 下的落盘格式（老数据还能读吗？）
- [ ] 改了默认行为 / 默认配置
- [ ] 只动文档 / 注释

## 截图

<!-- UI 改动请贴一张；没有就删掉这节 -->
