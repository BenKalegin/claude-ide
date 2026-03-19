import React, { useCallback, useRef } from 'react';

interface Props {
  direction: 'horizontal' | 'vertical';
  onResize: (delta: number) => void;
}

export function Resizer({ direction, onResize }: Props): React.ReactElement {
  const startPos = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    startPos.current = direction === 'horizontal' ? e.clientX : e.clientY;

    const handleMouseMove = (ev: MouseEvent) => {
      const current = direction === 'horizontal' ? ev.clientX : ev.clientY;
      const delta = current - startPos.current;
      startPos.current = current;
      onResize(delta);
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  }, [direction, onResize]);

  return (
    <div
      className={`resizer resizer-${direction}`}
      onMouseDown={handleMouseDown}
    />
  );
}
