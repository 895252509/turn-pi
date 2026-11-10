#!/usr/bin/env node
// 网段冲突预检：compose 建 default 网络时，如果目标 subnet 和已有 docker 网络重叠，
// daemon 直接拒绝：
//   invalid pool request: Pool overlaps with other one on this address space
// 这个报错要等镜像构建（几十秒）跑完才出现，只看日志很难定位到是哪个网络。
//
// 真实踩过的坑：项目从 pi-webchat 改名成 turn-pi 后，compose 项目名变了（新网络叫
// turn-pi_default），但旧网络 pi-webchat_default 还挂着别的容器（pi-agent），继续占着
// 老 compose 里写死的 10.211.77.0/24。新项目再要同一网段 —— 必撞。
//
// 这个脚本在 up 之前把「目标网段 / 撞上谁 / 怎么办」一次说清。
// 目标网段与 compose 同源：TURN_PI_SUBNET，未设置则取 compose 里的默认值。

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const composePath = join(root, "docker-compose.yml");

// 从 compose 里抠出默认值：${TURN_PI_SUBNET:-10.211.78.0/24}
function defaultSubnetFromCompose() {
  const text = readFileSync(composePath, "utf8");
  const m = text.match(/\$\{TURN_PI_SUBNET:-([0-9.]+\/\d+)\}/);
  if (m) return m[1];
  const direct = text.match(/^\s*- subnet:\s*([0-9.]+\/\d+)\s*$/m);
  return direct ? direct[1] : null;
}

// 本项目 compose 会管理的网络前缀。必须排除，否则「网络已经建好、这次只是复用」
// 的正常情况（天天 make up）会被误判成冲突。
// 优先级和 compose 自己一致：COMPOSE_PROJECT_NAME > compose 顶层 name: > 目录名。
function composeProjectName() {
  if (process.env.COMPOSE_PROJECT_NAME) return process.env.COMPOSE_PROJECT_NAME;
  const text = readFileSync(composePath, "utf8");
  const m = text.match(/^name:\s*(\S+)\s*$/m);
  return m ? m[1] : basename(root);
}

function ipToInt(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error("地址不合法: " + ip);
  }
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

// 返回 [start, end] 闭区间
function cidrRange(cidr) {
  const [ip, prefixRaw] = cidr.split("/");
  const prefix = Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error("掩码不合法: " + cidr);
  }
  const size = 2 ** (32 - prefix);
  const start = ipToInt(ip) - (ipToInt(ip) % size);
  return [start, start + size - 1];
}

function overlaps(a, b) {
  const [as, ae] = cidrRange(a);
  const [bs, be] = cidrRange(b);
  return as <= be && bs <= ae;
}

function listDockerSubnets(project) {
  let names;
  try {
    names = execFileSync("docker", ["network", "ls", "--format", "{{.Name}}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    // docker CLI 不可用（或不在这台机器上）就不拦，up 自己会再说一遍。
    return null;
  }
  const subnets = [];
  for (const name of names) {
    // 本项目的网络归 compose 自己管：已存在且网段一致时是复用，不是冲突。
    if (name === project || name.startsWith(project + "_")) continue;
    let out;
    try {
      out = execFileSync(
        "docker",
        ["network", "inspect", name, "--format", "{{range .IPAM.Config}}{{.Subnet}} {{end}}"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch {
      continue;
    }
    for (const s of out.split(/\s+/).map((x) => x.trim())) {
      if (s && s.includes("/") && /^\d+\.\d+\.\d+\.\d+\//.test(s)) {
        subnets.push({ name, subnet: s });
      }
    }
  }
  return subnets;
}

const desired = process.env.TURN_PI_SUBNET || defaultSubnetFromCompose();
if (!desired) {
  console.log("网段预检：compose 里没找到显式 subnet，跳过。");
  process.exit(0);
}

const project = composeProjectName();
const subnets = listDockerSubnets(project);
if (subnets === null) {
  console.log("网段预检：docker CLI 不可用，跳过（up 会自己报错）。");
  process.exit(0);
}

let conflicts;
try {
  conflicts = subnets.filter((s) => overlaps(desired, s.subnet));
} catch (err) {
  console.error("网段预检失败：" + err.message);
  process.exit(1);
}

if (conflicts.length === 0) {
  console.log("网段预检：OK（" + desired + " 未被占用）");
  process.exit(0);
}

console.error("网段预检：目标网段 " + desired + " 和已有 docker 网络重叠，up 一定会失败。");
console.error("  报错长这样：invalid pool request: Pool overlaps with other one on this address space");
console.error("");
console.error("  撞上的网络：");
for (const c of conflicts) console.error("    - " + c.name + "  " + c.subnet);
console.error("");
console.error("  三种修法：");
console.error("    1) 换本项目网段（推荐，不动别人）：TURN_PI_SUBNET=10.211.79.0/24 make up");
console.error("       想长期生效就把 TURN_PI_SUBNET 写进 .env");
console.error("    2) 长期改默认值：改 docker-compose.yml 末尾 subnet 的默认网段");
console.error("    3) 清理没人用的旧网络：docker network rm <上面列出的名字>");
console.error("       （网络里还挂着容器就会 rm 失败，说明它仍在使用，别硬删）");
process.exit(1);
