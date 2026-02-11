import { useRef, useEffect } from 'react';

export const Dust = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Basic setup for the canvas
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#cfe9ff';
    ctx.font = '24px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('Welcome to From Dust Side-Scroller! - Jarvis', canvas.width / 2, canvas.height / 2);

  }, []);

  return (
    <canvas ref={canvasRef} style={{ display: 'block' }}></canvas>
  );
};
