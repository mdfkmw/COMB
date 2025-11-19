interface LogoProps {
  height: number
}

function VisaLogo({ height }: LogoProps) {
  const width = (height / 40) * 120
  return (
    <svg
      viewBox="0 0 120 40"
      role="img"
      aria-label="Siglă Visa"
      xmlns="http://www.w3.org/2000/svg"
      style={{ height, width }}
      className="drop-shadow-sm"
    >
      <rect width="120" height="40" rx="6" fill="#1a1f71" />
      <path d="M21 11h14l3 18h-7l-.5-3h-5.5l-.9 3h-7.3z" fill="#fff" />
      <path d="M27.3 17h-3.6l-2.5 8h3.7z" fill="#f7b600" />
      <path
        d="M40 11h6.4c3.6 0 5.9 1.5 5.9 4.4 0 1.8-.8 3-2.4 3.8l3.7 9.8h-7l-2.7-7.4h-.2V29h-6.7z"
        fill="#fff"
      />
      <path d="M63 11h7l-4.2 18h-7z" fill="#fff" />
      <path d="M83.7 11.1c3.9 0 6.6 1.9 6.6 4.9 0 2.1-1.3 3.7-4.1 4.6l-2.3.8c-1 .3-1.4.7-1.4 1.1s.4.7 1.4.7c1.3 0 2.9-.4 4.2-1.1l1.4 4.5c-1.8 1-4.2 1.6-6.6 1.6-4.4 0-7.3-2.1-7.3-5.2 0-2.1 1.5-3.8 4.3-4.8l2.2-.8c.9-.3 1.3-.6 1.3-1 0-.6-.6-.9-1.6-.9-1.4 0-3 .4-4.4 1.1l-1.3-4.4c1.6-.9 4.1-1.6 6.6-1.6z" fill="#fff" />
    </svg>
  )
}

function MastercardLogo({ height }: LogoProps) {
  const width = (height / 40) * 120
  return (
    <svg
      viewBox="0 0 120 40"
      role="img"
      aria-label="Siglă Mastercard"
      xmlns="http://www.w3.org/2000/svg"
      style={{ height, width }}
      className="drop-shadow-sm"
    >
      <rect width="120" height="40" rx="6" fill="#fff" stroke="#d9d9d9" />
      <circle cx="55" cy="20" r="12" fill="#eb001b" />
      <circle cx="65" cy="20" r="12" fill="#f79e1b" fillOpacity="0.95" />
      <text
        x="92"
        y="24"
        textAnchor="middle"
        fontFamily="'Helvetica Neue', Arial, sans-serif"
        fontSize="9"
        fontWeight="600"
        fill="#1d1d1b"
      >
        mastercard
      </text>
    </svg>
  )
}

interface CardBrandLogosProps {
  size?: 'md' | 'lg'
  className?: string
}

export default function CardBrandLogos({ size = 'md', className }: CardBrandLogosProps) {
  const height = size === 'lg' ? 40 : 32
  const classes = ['flex items-center gap-4', className].filter(Boolean).join(' ')
  return (
    <div className={classes}>
      <VisaLogo height={height} />
      <MastercardLogo height={height} />
    </div>
  )
}
