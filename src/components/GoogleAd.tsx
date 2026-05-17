import { useEffect, useRef } from 'react';

interface GoogleAdProps {
  slot: string;
  format?: 'auto' | 'fluid' | 'rectangle';
  responsive?: 'true' | 'false';
  className?: string;
  style?: React.CSSProperties;
}

declare global {
  interface Window {
    adsbygoogle: any[];
  }
}

export function GoogleAd({ 
  slot, 
  format = 'auto', 
  responsive = 'true', 
  className = '',
  style = { display: 'block' }
}: GoogleAdProps) {
  const adRef = useRef<HTMLModElement>(null);
  const clientId = 'ca-pub-5369536521058508'; 

  useEffect(() => {
    // Only attempt to push if the script has loaded and global is available
    const pushAd = () => {
      try {
        if (typeof window !== 'undefined' && window.adsbygoogle) {
          window.adsbygoogle.push({});
        }
      } catch (err) {
        console.warn('AdSense push error:', err);
      }
    };

    // If script is already in index.html, we just need to push
    pushAd();
  }, [slot]);

  return (
    <div className={`ad-container overflow-hidden w-full mx-auto my-8 ${className}`}>
      <ins
        className="adsbygoogle"
        style={style}
        data-ad-client={clientId}
        data-ad-slot={slot}
        data-ad-format={format}
        data-full-width-responsive={responsive}
        ref={adRef}
      />
      <div className="text-[10px] text-center text-[#8E9299] font-mono mt-1 uppercase tracking-tighter opacity-50">
        Advertisement
      </div>
    </div>
  );
}
