import React, { useCallback, useEffect, useRef, useState } from 'react';
import './SplashScreen.css';

const FIRST_LAUNCH_MESSAGE = 'Hi Hungry, I\'m DAD';

const MESSAGES = [
  'DAD can build anything',
  'DAD said it\'s my turn on the terminal!',
  'Go ask DAD',
  'DAD\'s home!',
  'Because DAD said so.',
  'Don\'t tell your mother.',
  'Pull my finger.',
  'Who touched the thermostat?',
  'Back in my day, we deployed on Fridays.',
];

type Phase = 'loading' | 'fade-in' | 'hold' | 'fade-out' | 'done';

interface Props {
  onComplete: () => void;
}

export default function SplashScreen({ onComplete }: Props): React.ReactElement | null {
  const [phase, setPhase] = useState<Phase>('loading');
  const [message, setMessage] = useState('');
  const isFirstLaunchRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skippedRef = useRef(false);

  // Load message on mount
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const first = await window.dad.isFirstLaunch();
        if (cancelled) return;
        isFirstLaunchRef.current = first;
        if (first) {
          setMessage(FIRST_LAUNCH_MESSAGE);
        } else {
          setMessage(MESSAGES[Math.floor(Math.random() * MESSAGES.length)]);
        }
        // Start fade-in on next frame
        requestAnimationFrame(() => {
          if (!cancelled) setPhase('fade-in');
        });
      } catch {
        if (!cancelled) {
          setMessage(MESSAGES[0]);
          requestAnimationFrame(() => {
            if (!cancelled) setPhase('fade-in');
          });
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Phase transitions
  useEffect(() => {
    if (phase === 'fade-in') {
      // After fade-in (1s) → hold
      timerRef.current = setTimeout(() => setPhase('hold'), 1000);
    } else if (phase === 'hold') {
      // After hold (3s) → fade-out
      timerRef.current = setTimeout(() => setPhase('fade-out'), 3000);
    } else if (phase === 'fade-out') {
      // After fade-out (1s) → done (or instant if skipped)
      timerRef.current = setTimeout(() => setPhase('done'), skippedRef.current ? 50 : 1000);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [phase]);

  // When done, mark first launch complete and notify parent
  useEffect(() => {
    if (phase !== 'done') return;
    if (isFirstLaunchRef.current) {
      void window.dad.markFirstLaunchComplete();
    }
    onComplete();
  }, [phase, onComplete]);

  // Skip on any key or mouse press — snap out instantly
  const handleSkip = useCallback(() => {
    if (phase === 'done' || phase === 'loading') return;
    if (timerRef.current) clearTimeout(timerRef.current);
    skippedRef.current = true;
    setPhase('fade-out');
  }, [phase]);

  useEffect(() => {
    const onKey = () => handleSkip();
    const onMouse = () => handleSkip();
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onMouse);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onMouse);
    };
  }, [handleSkip]);

  if (phase === 'done') return null;

  const className = [
    'splash-screen',
    phase === 'fade-in' || phase === 'hold' ? 'splash-screen--visible' : '',
    phase === 'fade-out' && !skippedRef.current ? 'splash-screen--fading' : '',
    phase === 'fade-out' && skippedRef.current ? 'splash-screen--snap' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={className}>
      <span className="splash-screen__text">{message}</span>
    </div>
  );
}
