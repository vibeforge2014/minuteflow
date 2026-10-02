/**
 * 支付/授权后端配置。全部来自环境变量（服务器上由 systemd EnvironmentFile 提供）：
 * 商户密钥与证书只存在于服务器，绝不进入仓库或客户端。
 * 任何一项缺失都不阻止启动——未配置的通道下单时返回可读错误，mock 通道默认可用，
 * 便于在商户号开通前完成全链路联调（见 README 的密钥 checklist）。
 */
import { readFileSync } from "node:fs";

const env = process.env;

function optionalFile(value) {
  if (!value) return "";
  try {
    return readFileSync(value, "utf8");
  } catch {
    return "";
  }
}

export const config = {
  port: Number(env.LICENSE_PORT || 8787),
  host: env.LICENSE_HOST || "127.0.0.1",
  /** 数据库文件路径（SQLite WAL）。 */
  dbPath: env.LICENSE_DB_PATH || "./data/license.sqlite",
  /** 对外_BASE：拼 notify_url 等绝对地址用，必须与 nginx 对外域名一致。 */
  publicBaseUrl: env.LICENSE_PUBLIC_BASE_URL || "https://zensoft.top",
  productId: "minuteflow-desktop",
  /** 固定售价（分）：金额只在服务端决定，客户端与前端无权指定。 */
  amountFen: 9_900,
  currency: "CNY",
  /** 订单有效期（毫秒）：微信/支付宝二维码同寿命。 */
  orderTtlMs: 15 * 60_000,
  /** 每个激活码最多绑定的设备数。 */
  maxDevicesPerLicense: 2,
  /** 下单接口按 IP 的简单限流：窗口内最大下单数。 */
  orderRateLimit: { windowMs: 60_000, max: 5 },
  /** 沙箱联调通道：未配置任何真实商户密钥时默认开启，商户密钥到位后需显式关闭。 */
  mockEnabled: env.LICENSE_MOCK_ENABLED
    ? env.LICENSE_MOCK_ENABLED === "1"
    : Boolean(!env.WECHAT_MCHID && !env.ALIPAY_APP_ID),

  wechat: {
    mchid: env.WECHAT_MCHID || "",
    /** Native 下单使用的 appid（公众号 / 开放平台应用均可）。 */
    appid: env.WECHAT_APPID || "",
    /** APIv3 密钥（32 字节），用于回调解密。 */
    apiv3Key: env.WECHAT_APIV3_KEY || "",
    /** 商户 API 证书序列号。 */
    serialNo: env.WECHAT_SERIAL_NO || "",
    /** 商户私钥（PEM 文本，或指向文件的路径）。 */
    privateKey: optionalFile(env.WECHAT_PRIVATE_KEY_PATH || env.WECHAT_PRIVATE_KEY),
    /** 微信支付平台公钥（公钥模式）或平台证书（PEM），用于回调验签。 */
    platformPublicKey: optionalFile(env.WECHAT_PLATFORM_PUBLIC_KEY_PATH || env.WECHAT_PLATFORM_PUBLIC_KEY)
  },
  alipay: {
    appId: env.ALIPAY_APP_ID || "",
    /** 应用私钥（PKCS#8 PEM）。 */
    privateKey: optionalFile(env.ALIPAY_PRIVATE_KEY_PATH || env.ALIPAY_PRIVATE_KEY),
    /** 支付宝公钥（非应用公钥），用于异步通知验签。 */
    alipayPublicKey: optionalFile(env.ALIPAY_PUBLIC_KEY_PATH || env.ALIPAY_PUBLIC_KEY),
    /** 网关：生产 https://openapi.alipay.com，沙箱用 https://openapi-sandbox.dl.alipay.com。 */
    gateway: env.ALIPAY_GATEWAY || "https://openapi.alipay.com",
    /**
     * 收单产品：page = 电脑网站支付（跳支付宝收银台，桌面端收银台内呈现扫码/登录）；
     * face = 当面付 precreate（站内二维码，需单独签约当面付）。默认 page。
     */
    product: env.ALIPAY_PRODUCT === "face" ? "face" : "page"
  },
  /** 激活码静态加密主密钥（32 字节 hex/base64/text 均可，长度补齐到 32 字节）。 */
  masterKey: env.LICENSE_MASTER_KEY || ""
};

/** 各通道是否已配置齐真实密钥。 */
export function channelReady(channel) {
  if (channel === "wechat") {
    return Boolean(config.wechat.mchid && config.wechat.appid && config.wechat.apiv3Key
      && config.wechat.serialNo && config.wechat.privateKey && config.wechat.platformPublicKey);
  }
  if (channel === "alipay") {
    return Boolean(config.alipay.appId && config.alipay.privateKey && config.alipay.alipayPublicKey);
  }
  if (channel === "mock") return config.mockEnabled;
  return false;
}
