type Props = {
  size?: number;
};

export function KugouHarmonyAiIcon(props: Props) {
  const size = props.size || 28;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="#F5F8FF" stroke="#D6E2F7" />
      <text x="4.4" y="16.7" fill="#2563EB" fontSize="10.6" fontWeight="800" fontFamily="Inter, Arial, sans-serif">
        K
      </text>
      <text x="11.9" y="16.7" fill="#16A34A" fontSize="10.6" fontWeight="800" fontFamily="Inter, Arial, sans-serif">
        H
      </text>

      <path d="M10.2 12.3c.95-1 2.25-1 3.2 0" stroke="#0EA5A3" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="10" cy="12.3" r=".9" fill="#0EA5A3" />
      <circle cx="13.4" cy="12.3" r=".9" fill="#0EA5A3" />

      <path d="M7.2 7h9.6" stroke="#7C3AED" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M8.8 7 12 4.5 15.2 7" fill="#7C3AED" />
      <text x="12" y="6.7" textAnchor="middle" fill="#fff" fontSize="2.8" fontWeight="800" fontFamily="Inter, Arial, sans-serif">
        AI
      </text>
    </svg>
  );
}

