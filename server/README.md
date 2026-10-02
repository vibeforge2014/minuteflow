# MinuteFlow 授权/支付后端

零 npm 依赖（Node ≥ 22.5，需 `node:sqlite`，推荐 Node 24）的支付与激活验证服务：
官网购买页下单 → 微信 Native / 支付宝当面付二维码 → 回调落账 → 签发激活码 →
应用端 `POST /verify` 激活（与 `electron/services/licensing.mjs` 协议一致）。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/license/orders` | `{channel:"wechat"\|"alipay"\|"mock"}` 创建订单，返回二维码内容；按 IP 限流 5 次/分钟 |
| GET | `/api/license/orders/:id` | 购买页 2s 轮询；`paid` 时携带 `licenseKey`；临期未通知会主动查单对账 |
| POST | `/api/license/webhooks/wechat` | 微信支付 APIv3 回调：平台公钥验签 + AES-256-GCM 解密 + 幂等落账 |
| POST | `/api/license/webhooks/alipay` | 支付宝异步通知：表单 RSA2 验签 + 幂等落账，回 `success` |
| POST | `/api/license/verify` | 激活验证；401 无效 / 410 已撤销（退款）为终态；设备超限 200+`valid:false` 带原因 |
| GET | `/healthz` | 存活探针 |

金额（¥99 = 9900 分）只由服务端决定；数据库只存激活码的 SHA-256 索引 + AES-GCM 密文。

## 部署（zensoft.top）

> `deploy-license.yml` 在目标目录不存在时会尝试免密 `sudo mkdir` 自举；部署用户无 sudo 时首次部署会明确报错并指向本节——按下面步骤手动完成一次初始化即可，之后的代码更新由 workflow 自动 rsync + 重启。

```bash
# 0. Node >= 22（node:sqlite），先确认：node -v
# 1. 代码与数据目录（权限拆分：代码根目录归部署用户供 CI rsync，data/ 归 www-data 供服务写库）
sudo mkdir -p /opt/minuteflow-license/data
sudo chown <部署用户=ZENSOFT_SSH_USER> /opt/minuteflow-license
sudo chown -R www-data:www-data /opt/minuteflow-license/data

# 2. 环境变量（chmod 600；systemd 以 root 读取，无需 www-data 可读）
sudo mkdir -p /etc/minuteflow-license
sudoedit /etc/minuteflow-license/env     # 见下方清单

# 3. systemd（代码首次由 deploy-license.yml rsync 到位后再 start；
#    enable 先行，workflow 部署完会 sudo -n restart 自动拉起）
sudo cp /opt/minuteflow-license/minuteflow-license.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable minuteflow-license

# 4. 允许部署用户免密重启这一项服务（仅此一条，最小授权，CI 部署后自动重启用）
echo '<部署用户> ALL=(root) NOPASSWD: /usr/bin/systemctl restart minuteflow-license' \
  | sudo tee /etc/sudoers.d/minuteflow-license-deploy
sudo chmod 440 /etc/sudoers.d/minuteflow-license-deploy

# 5. nginx：把 nginx.conf.example 的 location 段并入 zensoft.top 站点后
sudo nginx -t && sudo systemctl reload nginx
#    首次验证：触发一次 deploy-license.yml，绿了即
curl -s https://zensoft.top/api/license/healthz
```

### 环境变量清单 `/etc/minuteflow-license/env`

```bash
LICENSE_PORT=8787
LICENSE_HOST=127.0.0.1
LICENSE_DB_PATH=/opt/minuteflow-license/data/license.sqlite
LICENSE_PUBLIC_BASE_URL=https://zensoft.top
# 激活码静态加密主密钥：openssl rand -hex 32 生成一次，永久保存（丢失则已发码不可重显）
LICENSE_MASTER_KEY=<openssl rand -hex 32>

# --- 微信支付（APIv3 + Native）---
WECHAT_MCHID=<商户号>
WECHAT_APPID=<绑定的 appid>
WECHAT_APIV3_KEY=<APIv3 密钥 32 字节>
WECHAT_SERIAL_NO=<商户 API 证书序列号>
WECHAT_PRIVATE_KEY_PATH=/etc/minuteflow-license/wechat_apiclient_key.pem
WECHAT_PLATFORM_PUBLIC_KEY_PATH=/etc/minuteflow-license/wechat_platform_public_key.pem

# --- 支付宝（当面付）---
ALIPAY_APP_ID=<应用 appid>
ALIPAY_PRIVATE_KEY_PATH=/etc/minuteflow-license/alipay_app_private_key.pem
ALIPAY_PUBLIC_KEY_PATH=/etc/minuteflow-license/alipay_public_key.pem
# 沙箱联调时改为 https://openapi-sandbox.dl.alipay.com
# ALIPAY_GATEWAY=https://openapi.alipay.com

# 商户密钥到位后显式关闭沙箱通道
LICENSE_MOCK_ENABLED=0
```

密钥文件内容为 PEM 文本；`*_PATH` 与直接给 `WECHAT_PRIVATE_KEY=` 文本二选一。
**商户密钥只存在这台服务器**，绝不进仓库或客户端。

## 商户号开通 checklist

**微信支付**（pay.weixin.qq.com，需企业主体）：
1. 开通「Native 支付」产品权限；
2. API 安全：申请 API 证书（得到序列号 + `apiclient_key.pem`）、设置 APIv3 密钥；
3. 下载「微信支付公钥」（公钥模式，2024 年后新商户默认），存为 platform public key；
4. 回调地址无需在后台配置（下单请求里带 `notify_url`），但必须为 `https://zensoft.top`。

**支付宝**（open.alipay.com，当面付需签约）：
1. 创建「网页/移动应用」拿到 appid；
2. 密钥工具生成应用密钥对，应用私钥上传公钥，记录「支付宝公钥」（不是应用公钥！）；
3. 签约「当面付」；
4. 沙箱：在开放平台沙箱环境用 `ALIPAY_GATEWAY=https://openapi-sandbox.dl.alipay.com` 联调。

## 退款（7 天承诺）

```bash
sudo systemctl stop minuteflow-license   # 避免并发写（可选）
sudo -u www-data LICENSE_DB_PATH=/opt/minuteflow-license/data/license.sqlite \
  node /opt/minuteflow-license/src/bin/refund.mjs <orderId> "用户申请退款"
sudo systemctl start minuteflow-license
```

通道退款幂等（同 refundNo 重跑不会重复退）；本地落账把订单转 `refunded` 并吊销激活码，
该码下次验证收到 410（终态无效，不进入离线宽限）。

## 本地联调（mock 通道）

未配置任何商户密钥时 mock 通道自动开启：下单返回假二维码，3 秒后自动 paid 并发码，
官网 buy 页会显示「沙箱模式」徽标——商户号下来前即可全链路（下单→扫码→轮询→出码→
应用激活→重启保持）联调。填入密钥后设 `LICENSE_MOCK_ENABLED=0` 关闭。

```bash
LICENSE_DB_PATH=/tmp/license.sqlite LICENSE_PORT=8787 node server/src/index.mjs
```

## 日志

`journalctl -u minuteflow-license -f`：下单/落账/验签失败均有一行记录（不含密钥与激活码明文）。
