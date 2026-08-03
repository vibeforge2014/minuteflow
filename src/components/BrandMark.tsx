interface BrandMarkProps {
  className?: string;
  size?: number;
}

export function BrandMark({ className, size }: BrandMarkProps) {
  const source = window.location.protocol === "file:"
    ? new URL("./brand-mark.png", window.location.href).href
    : window.location.pathname.startsWith("/meeting-assistant-site")
      ? "/meeting-assistant-site/brand-mark.png"
      : "/brand-mark.png";

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
