/**
 * 品牌标（珊瑚橙圆角砖 + 会议文档/波形符号）：<img> 形式的 logo。
 * 按运行环境解析图片地址：构建注入的 BASE_URL（官网 /minuteflow/ 子路径、
 * GitHub Pages、本地开发根路径）或 Electron file:// 协议下的文档相对路径。
 * 位置：官网导航、加载页与设置页等处复用。
 */
interface BrandMarkProps {
  className?: string;
  size?: number;
}

export function BrandMark({ className, size }: BrandMarkProps) {
  // 官网构建由 SITE_BASE_PATH 注入 BASE_URL（如 /minuteflow/），深层路由也指向正确子路径；
  // Electron 打包后页面走 file:// 协议，必须相对当前文档解析。
  const source = window.location.protocol === "file:"
    ? new URL("./brand-mark.png", window.location.href).href
    : `${(import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "")}/brand-mark.png`;

  return (
    <img
      className={className}
      src={source}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      draggable={false}
    />
  );
}
