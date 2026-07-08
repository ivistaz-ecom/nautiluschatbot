import Image from 'next/image';

interface LogoProps {
  size?: 'sm' | 'md' | 'lg';
  showText?: boolean;
}

const sizes = {
  sm: { img: 28, text: 'text-sm' },
  md: { img: 36, text: 'text-sm' },
  lg: { img: 56, text: 'text-2xl' },
};

export function Logo({ size = 'md', showText = true }: LogoProps) {
  const s = sizes[size];
  return (
    <div className="flex items-center gap-3">
      <Image
        src="/white-logo.webp"
        alt="Nautilus Shipping"
        width={s.img}
        height={s.img}
        className="flex-shrink-0 object-contain"
        priority
      />
      {showText && (
        <div className="min-w-0">
          <p className={`font-semibold text-white truncate ${s.text}`}>Nautilus Shipping</p>
          {size !== 'sm' && (
            <p className="text-xs text-white/50">Knowledge Base</p>
          )}
        </div>
      )}
    </div>
  );
}
