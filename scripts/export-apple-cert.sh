#!/usr/bin/env bash
#
# 导出本机登录钥匙串里的 Developer ID 证书（含私钥）为 p12，
# 供 CI runner 导入后做 Developer ID 签名 + 公证。
#
# 用法（在 macOS 上，且已登录钥匙串解锁）：
#   EXPORT_PWD='你自己定的p12导出密码' bash scripts/export-apple-cert.sh
#
# 脚本会把 p12 写到 $RUNNER_TEMP（CI）或 /tmp（本地），并打印其 base64。
# 请将整段 base64 复制后粘贴到 GitHub 仓库 Secrets 的 APPLE_CERT_P12_BASE64，
# 再把同一个密码填到 APPLE_CERT_PASSWORD。
#
# 注意：security export 不支持按名称过滤，会导出登录钥匙串里的全部 identity；
# codesign 在 CI 中会按精确身份名选取 Developer ID，其余 identity 无害。
set -euo pipefail

if [ -z "${EXPORT_PWD:-}" ]; then
  echo "请通过环境变量 EXPORT_PWD 提供 p12 导出密码：" >&2
  echo '  EXPORT_PWD="你的密码" bash scripts/export-apple-cert.sh' >&2
  exit 1
fi

LOGIN="$HOME/Library/Keychains/login.keychain-db"
OUT="${RUNNER_TEMP:-/tmp}/apple-cert.p12"
IDENTITY_NAME="Developer ID Application: Zhen Qian (LPW4Z3BN69)"

# 先确认目标证书确实在登录钥匙串里
if ! security find-identity -v -p codesigning "$LOGIN" 2>/dev/null | grep -qF "$IDENTITY_NAME"; then
  echo "错误：登录钥匙串未找到『$IDENTITY_NAME』。请确认证书已安装且钥匙串已解锁。" >&2
  exit 1
fi

# 导出全部 identity（证书 + 私钥）为 pkcs12；若钥匙串锁定会交互式要求解锁密码。
security export \
  -k "$LOGIN" \
  -t identities \
  -f pkcs12 \
  -o "$OUT" \
  -P "$EXPORT_PWD"

# 校验导出的 p12 确实包含 Developer ID 证书
if command -v openssl >/dev/null 2>&1; then
  COUNT=$(openssl pkcs12 -in "$OUT" -nokeys -passin "pass:$EXPORT_PWD" 2>/dev/null \
    | grep -cF "$IDENTITY_NAME" || true)
  if [ "$COUNT" -eq 0 ]; then
    echo "警告：导出的 p12 未检出 Developer ID 证书，请检查钥匙串。" >&2
  else
    echo "已确认 p12 包含 $COUNT 个 Developer ID 证书条目。" >&2
  fi
fi

echo "已生成 $OUT" >&2
echo "----- 复制以下 base64 到 GitHub Secret：APPLE_CERT_P12_BASE64 -----" >&2
base64 -i "$OUT"
echo "----- 结束（base64 到此为止）-----" >&2
echo "提示：把上面 EXPORT_PWD 的值填到 GitHub Secret：APPLE_CERT_PASSWORD" >&2
