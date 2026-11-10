#!/bin/sh
# git credential helper：用 Turn Pi 的租约换 Gitea token —— 不需要 node 的版本。
#
# 等价于同目录的 `git-credential-pi.mjs`，给没有 node 的运行环境（精简镜像、CI job、
# 只有 curl/busybox 的容器）用。协议完全一样：git 调 `get`，我们从 stdin 读 host，
# 把 `username=` / `password=` 写到 stdout。
#
# 用法（git 会自己调用 `get`）：
#   PI_CRED_LEASE=cr_... PI_BASE_URL=http://127.0.0.1:44100 \
#   git -c credential.helper='!sh scripts/git-credential-pi.sh' \
#     push origin HEAD
#
# 也可以用服务端返回的 `git.usage` 里的命令，把 helper 换成本文件；
# 或者服务端设置 PI_GIT_HELPER 指向它，让租约响应直接给出这条命令。
#
# 依赖：curl、wget、perl 三者之一（按此顺序自动降级；PI_GIT_HTTP=curl|wget|perl 可强制）。
# 约束（与 .mjs 一致）：端点只接受 loopback、租约带 TTL、scope 必须含 *:git:read/write。
#
# 安全约定：
#   - 只把 username/password 写 stdout，**绝不回显服务端原始响应**（那里面就是 token）；
#   - 除 `get` 以外的操作（store/erase）直接 exit 0，git 才不会把它当成失败；
#   - 非 2xx、解析不到 password 都返回非 0，让 git 明确报错而不是拿空口令去试。
case "$1" in get) ;; *) exit 0 ;; esac

lease="${PI_CRED_LEASE:-}"
[ -n "$lease" ] || { echo "PI_CRED_LEASE is required" >&2; exit 1; }
base=$(printf '%s' "${PI_BASE_URL:-http://127.0.0.1:44100}" | sed 's:/*$::')

host=""
while IFS= read -r line; do
  [ -z "$line" ] && break
  case "$line" in host=*) host=${line#host=} ;; esac
done
[ -n "$host" ] || { echo "host is required" >&2; exit 1; }

url="$base/api/cred/$lease/git-credential"
body=$(printf '{"protocol":"https","host":"%s"}' "$host")
want="${PI_GIT_HTTP:-auto}"

raw=""
if { [ "$want" = auto ] || [ "$want" = curl ]; } && command -v curl >/dev/null 2>&1; then
  raw=$(curl -sS -f -X POST -H 'content-type: application/json' --data "$body" "$url") || exit 1
elif { [ "$want" = auto ] || [ "$want" = wget ]; } && command -v wget >/dev/null 2>&1; then
  raw=$(wget -q -O - --header 'content-type: application/json' --post-data "$body" "$url") || exit 1
elif { [ "$want" = auto ] || [ "$want" = perl ]; } && command -v perl >/dev/null 2>&1; then
  # perl 走 core 模块自己发 HTTP/1.1：端点只有 loopback + http，不引 TLS。
  # 服务端用 res.end() 且没给 content-length，所以这里要自己处理 chunked。
  raw=$(PI_URL="$url" RESP="$body" perl -MIO::Socket::INET -e '
    my ($h,$p,$path) = $ENV{PI_URL} =~ m{^http://([^/:]+)(?::(\d+))?(/.*)$} or die "bad url\n";
    $p ||= 80;
    my $sock = IO::Socket::INET->new(PeerAddr=>$h, PeerPort=>$p, Proto=>"tcp", Timeout=>10)
      or die "connect: $!\n";
    binmode $sock;
    my $payload_out = $ENV{RESP};
    print $sock "POST $path HTTP/1.1\r\nHost: $h:$p\r\nContent-Type: application/json\r\n"
      . "Content-Length: " . length($payload_out) . "\r\nConnection: close\r\n\r\n" . $payload_out;
    my $raw = do { local $/; <$sock> } // "";
    my ($head, $payload) = split /\r?\n\r?\n/, $raw, 2;
    $head //= "";
    my ($status) = $head =~ m{^HTTP/\d\.\d (\d{3})};
    die "http " . ($status // "?") . "\n" unless ($status // "") =~ /^2/;
    if (($head =~ /transfer-encoding:\s*chunked/i) && defined $payload) {
      my ($out, $rest) = ("", $payload);
      while ($rest =~ s/^([0-9a-fA-F]+)\r?\n//) {
        my $len = hex($1);
        last if $len == 0;
        $out .= substr($rest, 0, $len);
        $rest = substr($rest, $len);
        $rest =~ s/^\r?\n//;
      }
      $payload = $out;
    }
    print $payload // "";
  ') || exit 1
else
  echo "no http client available (curl/wget/perl)" >&2
  exit 1
fi

# 只从响应里取这两个字段；token 本身不落盘、不进日志
username=$(printf '%s' "$raw" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')
password=$(printf '%s' "$raw" | sed -n 's/.*"password":"\([^"]*\)".*/\1/p')
[ -n "$password" ] || { echo "no password in response" >&2; exit 1; }

printf 'username=%s\npassword=%s\n' "${username:-oauth2}" "$password"
