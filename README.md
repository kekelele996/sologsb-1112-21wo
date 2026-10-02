# 鸟类环志记录与鸟点地图（gbbirdring）

面向环志站与鸟类监测志愿者：登记环志编号、鸟种与量度（喙/翅/尾/体重）、鸟点生境与调查批次，并在地图上查看鸟点分布。地图使用高德地图 JS API（key 走 `VITE_AMAP_KEY`），**未配置 key 时自动退化为本地 SVG 网格视图，构建与运行均不依赖该 key**。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21812>

停止并清理：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3 + TypeScript（`<script setup>`） |
| 构建 | Vite 6（`npm run build` 含 `vue-tsc --noEmit` 类型检查） |
| UI | Element Plus 2 |
| 路由 | Vue Router 4（5 条业务路由 + 404） |
| 状态 | Pinia（ringStore / measureStore / siteStore / sessionStore） |
| 地图 | 高德地图 JS API（可选，按需动态加载）+ 本地 SVG 网格退化视图 |
| 存储 | IndexedDB（Dexie，库名 `gbbirdring-db`） |
| 托管 | nginx:alpine（多阶段构建，SPA try_files + gzip） |

## 环志中心回收通报接入（v3）

统计台底部「环志中心回收通报」负责把中心通报接进统计。通报只有**环号、回收地、回收日期**，本站台账记的是当年环志时的**鸟种、量度、鸟点**，两边对不上时按归属分开：

- **回收地、回收日期、环号认中心**：通报原文落独立的 `recoveries` 表，重复接入按 `批次#环号` 幂等覆盖中心字段（环号大小写不敏感）。
- **鸟种、量度、鸟点认本站**：通报经 `ringId` 关联本站环志记录后在统计台拼接显示，中心报文不写入、不改写本站台账。
- **本站没有的环号挂起**：状态为「待处理」，可在本站补登环志后「重新比对挂起」，或人工指定一条本站记录（环号不一致需二次确认）；**绝不凭空生成环志记录**。
- **接入失败按中心口径重试**：中心地址拉取失败只记录错误、不动已写进本站的通报，点「重试」即可；逐行落库，单行失败不回滚其它行。
- **老数据升级**：v3 只新增 `recoveries` 表，不改 `rings`——升级后历史环志记录在中心口径下全部算「未回收」，回收记录只能由中心通报匹配产生。

接入方式：统计台「粘贴 / 文件接入」（粘贴中心下发的 JSON 或选择文件，可下载模板 / 填入示例通报）；中心提供接口地址时可填入地址「按中心拉取」（地址存浏览器 localStorage）。

## 地图 key 说明（可选）

- 未配置 `VITE_AMAP_KEY`：`<SiteMap>` 渲染本地 SVG 网格视图，标记按生境配色落在对应格位，表单拾取坐标即落到格位中心；**构建与运行都不依赖该 key**。
- 配置后：`.env` 里填 `VITE_AMAP_KEY=<你的 key>`，再 `docker compose up -d --build`（compose 通过 build args 传入，Dockerfile 用 `ARG VITE_AMAP_KEY` 注入 Vite）。高德控制台需为该访问域名开启 JS API。

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:21812
npm run build    # 类型检查 + 生产构建
```

## 目录结构

```
.
├── docker-compose.yml         # 顶层 name / COMPOSE_PROJECT_NAME 容器名 / 端口映射 / 可选 VITE_AMAP_KEY build arg
├── .env.example               # COMPOSE_PROJECT_NAME、FRONTEND_PORT、可选 VITE_AMAP_KEY
├── frontend/
│   ├── Dockerfile             # node:20-alpine 构建 → nginx:alpine 托管
│   ├── nginx.conf             # try_files SPA 回退 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/             # ring-record / morphometrics / bird-site / session（+ ui.ts）
│       ├── stores/            # ringStore / measureStore / siteStore / sessionStore
│       ├── components/common/ # SiteMap / MeasureInput / RingCodeInput / SpeciesPicker / StatBadge / FilterBar / EmptyPanel
│       ├── hooks/             # useSiteFilter / useAmap
│       ├── pages/             # RingBoard / RingList / MeasureEntry / SiteList / SessionList
│       ├── router/index.ts    # 路由表
│       └── utils/             # stats.ts / geo.ts / db.ts / export.ts（+ seed.ts / id.ts / plain.ts / format.ts）
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 统计台 | 鸟种数、初捕/重捕比、鸟点分布图、鸟种计数与生境分布 |
| `/rings` | 环志记录 | 金属环号 + 彩环双段录入与自动查重，重复时提示并跳转历史记录 |
| `/measure` | 量度测量 | 6 项量度带单位与范围校验，与同鸟种历史均值比对给出偏离提示 |
| `/sites` | 鸟点台账 | 地图 / SVG 网格双模式切换，表单拾取坐标即时落点，点位间距提示 |
| `/sessions` | 调查批次 | 观测条件录入，关闭批次后统计鸟种数、初捕数与重捕数 |

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbbirdring-db`），表：`rings`、`morphs`、`sites`、`sessions`、`recoveries`、`meta`。
- `db.version(1)` 建表声明索引；`db.version(2).upgrade(...)` 为环志表增加 `[speciesCn+ringDate]` 复合索引并回填历史彩环字段；`db.version(3)` 新增中心回收通报表 `recoveries`（历史环志记录不迁移，中心口径下均算未回收）。升级前可用顶栏「导出备份」导出全量 JSON。
- 首次打开且表为空时写入示例数据（6 个鸟点、4 个调查批次、18 条环志记录与 14 条量度）。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。
