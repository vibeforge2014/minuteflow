/**
 * 激活码找回邮件：阿里云邮件推送 DirectMail（RPC SingleSendMail），零依赖手写签名。
 * - RPC 签名：全部参数字典序 → RFC3986 percentEncode 拼接 →
 *   StringToSign = "GET&%2F&" + percentEncode(规范化串) →
 *   HMAC-SHA1(AccessKeySecret + "&") → base64；
 * - setMailTransportForTest：测试注入假通道断言收件人与内容，不打真实 API。
 * 参考：https://help.aliyun.com/zh/direct-mail/api-dm-2015-11-23-singlesendmail
 */
import { createHmac, randomUUID } from "node:crypto";
import { config } from "./config.mjs";

/** 严格 RFC3986 percentEncode：非保留字符仅 A-Za-z0-9-_.~，其余逐字节 %XX 大写。
 *  阿里云服务端验签用同款严格编码（' → %27、空格 → %20、* → %2A），
 *  encodeURIComponent 的宽松变体（保留 !'()*）会 SignatureDoesNotMatch。 */
function percentEncode(value) {
  const raw = Buffer.from(String(value), "utf8");
  let out = "";
  for (const byte of raw) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-_.~]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

async function directMailSend({ to, subject, html }) {
  const params = {
    AccessKeyId: config.mail.accessKeyId,
    Action: "SingleSendMail",
    AccountName: config.mail.accountName,
    AddressType: "1",
    ClickTrace: "0",
    Format: "JSON",
    FromAlias: config.mail.fromAlias,
    HtmlBody: html,
    RegionId: config.mail.region,
    ReplyToAddress: "false",
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: randomUUID(),
    SignatureVersion: "1.0",
    Subject: subject,
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    ToAddress: to,
    Version: "2015-11-23"
  };
  const canonical = Object.keys(params).sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join("&");
  const stringToSign = `GET&${percentEncode("/")}&${percentEncode(canonical)}`;
  const signature = createHmac("sha1", `${config.mail.accessKeySecret}&`)
    .update(stringToSign, "utf8")
    .digest("base64");
  const response = await fetch(`${config.mail.endpoint}/?${canonical}&${percentEncode("Signature")}=${percentEncode(signature)}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.Code) {
    const detail = payload.Code ? ` ${payload.Code} ${payload.Message ?? ""}` : "";
    throw new Error(`DirectMail 发送失败（HTTP ${response.status}${detail}）。`);
  }
  return payload;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 激活码邮件正文：购买后自动发送与找回共用同一套版式。
 * licenses: [{ key, issuedAt }]；intro 是首段说明，区分“购买送达”和“应请求找回”。
 */
export function licenseEmailHtml({ email, licenses, intro }) {
  const rows = licenses.map((license) => `
    <tr>
      <td style="padding:8px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:15px;letter-spacing:.5px;color:#b3502f;font-weight:600;">${escapeHtml(license.key || "（读取失败，请联系支持）")}</td>
      <td style="padding:8px 12px;color:#6b625c;">${escapeHtml((license.issuedAt || "").slice(0, 10))}</td>
    </tr>`).join("");
  return `
<div style="max-width:520px;margin:0 auto;padding:24px;font-family:-apple-system,'PingFang SC','Helvetica Neue',sans-serif;color:#2a2320;">
  <h2 style="margin:0 0 4px;font-size:18px;">MinuteFlow 激活码</h2>
  <p style="margin:0 0 16px;color:#6b625c;font-size:13px;">${escapeHtml(intro || `应 ${email} 的请求发送。若非本人操作请忽略本邮件。`)}</p>
  <table style="border-collapse:collapse;width:100%;background:#fdf6f2;border:1px solid #f3ddd2;border-radius:8px;">
    <tr><th align="left" style="padding:8px 12px;color:#9a8f88;font-size:12px;font-weight:500;">激活码</th><th align="left" style="padding:8px 12px;color:#9a8f88;font-size:12px;font-weight:500;">签发日期</th></tr>
    ${rows}
  </table>
  <p style="margin:16px 0 0;font-size:13px;line-height:1.7;color:#4a423d;">
    在 MinuteFlow 桌面应用「解锁 → 输入激活码」中粘贴即可。每个激活码最多绑定 2 台设备；
    换设备时先在「设置 → 通用 → 授权」停用本机。如有问题联系
    <a href="mailto:xhdp123@126.com" style="color:#b3502f;">xhdp123@126.com</a>。
  </p>
</div>`;
}

const defaultTransport = directMailSend;
let transport = defaultTransport;

/** 测试钩子：替换发送通道；传 null 恢复真实 DirectMail。 */
export function setMailTransportForTest(next) {
  transport = next ?? defaultTransport;
}

/** 发送一封邮件。抛错由调用方处理（recover 端点记日志但仍回通用成功，防枚举）。 */
export async function sendMail(payload) {
  return transport(payload);
}
