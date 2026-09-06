export default function MapleIcon({ size = 24, className = '' }: { size?: number; className?: string }) {
  return <img src="/maple-brand.png" alt="" aria-hidden="true" width={size} height={size} className={`maple-icon ${className}`} />;
}
