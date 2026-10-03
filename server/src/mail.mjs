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

/** RFC3986 percentEncode：空格 %20（非 +）、* → %2A、~ 不编码。 */
function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/\+/g, "%20")
    .replace(/\*/g, "%2A")
    .replace(/%7E/g, "~");
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
