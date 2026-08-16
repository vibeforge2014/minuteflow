/**
 * 品牌标（珊瑚橙圆角砖 + 会议文档/波形符号）：<img> 形式的 logo。
 * 按运行环境解析图片地址：GitHub Pages 子路径、Electron file:// 协议、本地开发根路径三种情况。
 * 位置：官网导航、加载页与设置页等处复用。
 */
interface BrandMarkProps {
  className?: string;
  size?: number;
}

export function BrandMark({ className, size }: BrandMarkProps) {
  // GitHub Pages 托管在子路径（如 /minuteflow/）时，从 pathname 提取项目前缀。
  const projectBase = window.location.hostname.endsWith(".github.io")
    ? `/${window.location.pathname.split("/").filter(Boolean)[0] ?? ""}`.replace(/\/+$/, "")
    : "";
  // Electron 打包后页面走 file:// 协议，必须相对当前文档解析；网页环境用根路径/子路径。
  const source = window.location.protocol === "file:"
    ? new URL("./brand-mark.png", window.location.href).href
    : `${projectBase}/brand-mark.png`;

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
