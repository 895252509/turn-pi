# Turn Pi：SDK 内嵌的 web chat
SHELL := /bin/bash

.PHONY: help up up-docker down logs sh build-web dev-web test-local check check-web \
	check-docker-socket check-net docker-cli pull-idle runtime-init runtime-sync runtime-status

help:
	@echo "make up         构建前端 + 镜像并后台启动（http://localhost:44100）"
	@echo "make up-docker  同上，并把宿主 docker socket 挂进容器（提权，见 docker-compose.docker.yml）"
	@echo "make down       停止并删除容器（data/ runtime/ 保留）"
	@echo "make logs       跟随日志"
	@echo "make sh         进容器 shell"
	@echo "make build-web  只构建前端到 web/dist（改完前端执行，刷新即可）"
	@echo "make dev-web    启动 Vite dev server（44101，/api 反代 44100）"
	@echo "make test-local 不建容器，用本机 node 直接跑（需要 node_modules 与 web/dist）"
	@echo "make check      server 语法自检 + 前后端端点契约 + 联网搜索/抓取离线回归（不连外网）"
	@echo "make check-web  前端类型检查 + 构建 + happy-dom 冒烟"
	@echo "make pull-idle  安全拉取：server/ 改动会等所有会话空闲后再快进并验证重启"
	@echo "make check-net  预检 compose 网段是否和已有 docker 网络冲突"
	@echo "make docker-cli 验证容器内的 docker CLI 能连上宿主 daemon（cli/server 版本）"
	@echo "make runtime-init   建 runtime/ 骨架，并把现有 sessions 复制进去（幂等）"
	@echo "make runtime-sync   切换前增量同步 sessions → runtime/sessions"
	@echo "make runtime-status 看运行态目录与文件数"

# compose 只挂载 ./web/dist，所以镜像启动前宿主机必须有一份构建产物。
# check-net 放在 build-web 前面：网段冲突时 daemon 要等镜像构建完才拒绝，
# 先拦一道省一次几十秒的空等。
up: check-net build-web
	docker compose up -d --build

up-docker: check-docker-socket check-net build-web
	docker compose -f docker-compose.yml -f docker-compose.docker.yml up -d --build

build-web:
	@# 总是显式带上 devDependencies：宿主环境可能预设 NODE_ENV=production
	npm install --include=dev --no-audit --no-fund
	npm run build:web

dev-web:
	npm run dev:web

down:
	docker compose down

logs:
	docker compose logs -f --tail=100

sh:
	docker compose exec -it webchat bash

test-local:
	node server/index.ts

# 直接 git pull 会立刻触发 node --watch，打断正在生成的轮次。
pull-idle:
	@node scripts/pull-when-idle.mjs

# 宿主 socket 不存在时 docker 会把它建成一个空目录，容器里的 CLI 之后只会报
# "permission denied"，排查起来很像权限问题。这里先拦一道，报错直接给三种修法。
check-docker-socket:
	@test -S "$${DOCKER_SOCK:-/var/run/docker.sock}" || { \
		echo "找不到 docker socket：$${DOCKER_SOCK:-/var/run/docker.sock}"; \
		echo "  docker 没起？      systemctl start docker"; \
		echo "  rootless docker？  DOCKER_SOCK=/run/user/$$(id -u)/docker.sock make up-docker"; \
		echo "  不需要容器内 docker？  make up（不叠 socket 层）"; \
		exit 1; }

# 网段预检：目标 subnet 已被别的 docker 网络占用时，up 会在构建完之后才失败并报
# "invalid pool request: Pool overlaps with other one on this address space"
check-net:
	@node scripts/check-network.mjs

# 从容器里验证客户端与宿主 daemon 都通（应打印 cli=20.10.x server=<宿主版本>）。
docker-cli:
	@docker compose exec -T webchat docker version --format 'cli={{.Client.Version}} server={{.Server.Version}}'
	@docker compose exec -T webchat docker compose version

# 容器里是 node --watch：server/ 语法一坏进程就直接崩，线上立刻 502。
# 这个目标用 Node 自带 TS 解析器（和运行时同一套）做纯语法检查，不启动服务。
# 最后一条是前后端契约检查：语法没问题但路由被删（页面报 405 method not allowed）
# 只有它能抓到，见 scripts/check-routes.mjs 的注释。
check:
	@node --experimental-strip-types --no-warnings scripts/check-server.mjs
	@node --experimental-strip-types --no-warnings scripts/check-search.mjs
	@node scripts/check-routes.mjs

check-web:
	@npm run check:web

# —— 运行态（PI_RUNTIME_DIR）————————————————————————
runtime-init:
	@bash scripts/runtime.sh init

runtime-sync:
	@bash scripts/runtime.sh sync

runtime-status:
	@bash scripts/runtime.sh status
