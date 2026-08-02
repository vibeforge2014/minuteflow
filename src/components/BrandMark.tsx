interface BrandMarkProps {
  className?: string;
  size?: number;
}

export function BrandMark({ className, size }: BrandMarkProps) {
  return (
    <img
      className={className}
      src="/brand-mark.png"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      draggable={false}
    />
  );
}
