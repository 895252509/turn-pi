# Turn Pi：SDK 内嵌的 web chat
#
# 两段构建：
#   web  —— 装 devDependencies，把 React 前端构建成 web/dist
#   run  —— 只装生产依赖，只带 dist 产物，镜像里没有 vite / typescript
#
# 开发时 compose 会把 ./web 和 ./server bind mount 进去，覆盖镜像里的副本；
# 单独部署（不带 bind mount）时，用的就是下面 COPY 进来的 dist。

# ---------- 1. 前端构建 ----------
FROM node:22-bookworm-slim AS web

WORKDIR /build

ARG NPM_REGISTRY=https://registry.npmmirror.com

# 依赖先装，利用层缓存
COPY package.json package-lock.json ./
RUN npm config set registry "$NPM_REGISTRY" \
 && npm ci --include=dev --no-audit --no-fund \
 && npm cache clean --force

COPY web ./web
RUN npm run build:web

# ---------- 2. 运行时 ----------
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PI_SKIP_VERSION_CHECK=1 \
    TZ=Asia/Shanghai

# git：隔离 worktree 要跑 git worktree add/status/remove（node:slim 不带，少它会 500）。
# docker.io：容器里的 agent 要能操作宿主 daemon（compose 挂了 /var/run/docker.sock）。
#     policy-rc.d 是 Debian 的标准做法：告诉 apt 别在这里启服务。
#     否则 postinst 会 `invoke-rc.d docker start`，在构建容器里拉一个起不来的 dockerd，
#     还会在镜像里留下一个空的 /var/run/docker.sock。
#     代价：连带 containerd/runc/iptables，约 +253MB；只用到 /usr/bin/docker 这一支客户端。
# curl/wget：slim 不自带，agent 调试、拉包、下面下载 compose 插件都要用（+4MB）。
# 其余常用工具（+58MB / 51 个包）：跑排障时需要但 slim 没有的
#     procps（ps/top/free）iproute2（ss/ip）lsof tree file         ← 看进程/端口/文件
#     jq less vim-tiny patch unzip zip strace socat netcat-openbsd  ← 看数据/改文件/抓网络
#     openssh-client rsync tmux python3 iputils-ping               ← 远程/同步/长任务/脚本
# 故意不装：ripgrep（pi 自带 grep/find 工具）、sudo（容器里就是 root）、
#     gcc/make（没有原生扩展要编）、cron/systemd（入口是 node，定时走 server/scheduler.ts）、
#     dnsutils（只为 dig 会拖进 libicu72 35MB，+40MB 不划算）。
# Debian 官方源在国内实测只有 ~10KB/s，装 300MB 要几小时；默认直接走阿里云（~0.8MB/s，HTTP）。
# 必须用 http:// 前缀：基础镜像里没有 ca-certificates，https 源在第一步 apt-get update
# 就握手失败（"certificate is NOT trusted"），然后 install 找不到包，exit 100。
# ca-certificates 是这次 install 才装上的，之后 git/curl 走 https 没问题。
ARG DEBIAN_MIRROR=http://mirrors.aliyun.com
RUN if [ -n "$DEBIAN_MIRROR" ]; then \
      for f in /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list; do \
        sed -i -e "s|http://deb.debian.org|$DEBIAN_MIRROR|g" -e "s|http://security.debian.org|$DEBIAN_MIRROR|g" "$f" 2>/dev/null || true; \
      done; \
    fi \
 && printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d \
 && chmod +x /usr/sbin/policy-rc.d \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git ca-certificates curl wget docker.io \
      procps iproute2 jq less file lsof tree unzip zip patch \
      openssh-client rsync vim-tiny strace tmux socat netcat-openbsd \
      python3 iputils-ping \
 && rm -f /usr/sbin/policy-rc.d \
 && docker --version \
 && curl --version \
 && wget --version \
 && jq --version \
 && python3 --version \
 && rm -rf /var/lib/apt/lists/*

# docker compose v2 插件：Debian 没有这个包，只有官方单文件二进制。
# 装到系统插件目录（docker 20.10 支持 cli-plugins），`docker compose` 就能用。
#
# 官方二进制在 github release 上，国内直连经常 SSL_ERROR_SYSCALL（实测连不上，
# 而且这一步会在镜像构建的最后才炸，前面几十秒全白跑）。所以主路径改成从
# docker-ce 国内镜像站取 deb、只解出二进制：
#   - 不装 docker-ce-cli：它和 Debian 的 docker.io 包冲突，我们只要 compose 这个文件。
#   - 不导 GPG key，用 [trusted=yes] 只读这一个源；索引用完即删。
# 镜像站拿不到才回退 github；两条路都失败就当场退出，不带病出门。
# 换镜像站：DEBIAN_MIRROR 管 apt，DOCKER_CE_MIRROR 管这里。
ARG DOCKER_CE_MIRROR=https://mirrors.aliyun.com/docker-ce
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"; \
    mkdir -p /usr/local/lib/docker/cli-plugins /tmp/compose-plugin; \
    cd /tmp/compose-plugin; \
    printf 'deb [trusted=yes] %s/linux/debian %s stable\n' "$DOCKER_CE_MIRROR" "$codename" \
      > /etc/apt/sources.list.d/docker-ce.list; \
    if apt-get -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/docker-ce.list \
               -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0 update \
       && apt-get -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/docker-ce.list \
               -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0 \
               download docker-compose-plugin; \
    then \
      dpkg-deb -x ./docker-compose-plugin_*.deb /tmp/compose-plugin/root; \
      install -m 0755 \
        /tmp/compose-plugin/root/usr/libexec/docker/cli-plugins/docker-compose \
        /usr/local/lib/docker/cli-plugins/docker-compose; \
    else \
      echo "docker compose 插件：镜像站 ($DOCKER_CE_MIRROR) 取不到，回退 github"; \
      case "$arch" in amd64) arch=x86_64 ;; arm64) arch=aarch64 ;; esac; \
      curl -fsSL --retry 3 --connect-timeout 15 \
        -o /usr/local/lib/docker/cli-plugins/docker-compose \
        "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$arch"; \
      chmod 0755 /usr/local/lib/docker/cli-plugins/docker-compose; \
    fi; \
    rm -rf /tmp/compose-plugin /etc/apt/sources.list.d/docker-ce.list /var/lib/apt/lists/*; \
    docker --version; \
    docker compose version

WORKDIR /app

ARG NPM_REGISTRY=https://registry.npmmirror.com

COPY package.json package-lock.json ./
RUN npm config set registry "$NPM_REGISTRY" \
 && npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

COPY server ./server
# 只要构建产物：index.html + assets
COPY --from=web /build/web/dist ./web/dist

EXPOSE 44100

# 热加载策略：
#   - server/**  由 node --watch 重启进程（会中断正在跑的那一轮，SSE 重连后自动同步）
#   - web/**     已构建成静态资源，刷新浏览器即可（改完要重新 npm run build:web）
CMD ["node", "--watch-path=./server", "server/index.ts"]
