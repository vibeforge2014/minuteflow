interface BrandMarkProps {
  className?: string;
  size?: number;
}

export function BrandMark({ className, size }: BrandMarkProps) {
  const projectBase = window.location.hostname.endsWith(".github.io")
    ? `/${window.location.pathname.split("/").filter(Boolean)[0] ?? ""}`.replace(/\/+$/, "")
    : "";
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
