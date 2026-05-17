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
  const clientId = import.meta.env.VITE_GOOGLE_ADS_CLIENT_ID || 'ca-pub-XXXXXXXXXXXXXXXX'; // Placeholder or env

  useEffect(() => {
    // Add Script Tag if not already present
    if (!document.querySelector('script[src*="adsbygoogle.js"]')) {
      const script = document.createElement('script');
      script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${clientId}`;
      script.async = true;
      script.crossOrigin = 'anonymous';
      document.head.appendChild(script);
    }

    // Push the ad
    try {
      if (window.adsbygoogle) {
        window.adsbygoogle.push({});
      }
    } catch (err) {
      console.error('Google Ads Error:', err);
    }
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
