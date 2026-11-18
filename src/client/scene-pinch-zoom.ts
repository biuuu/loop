type PointerIdentity = Pick<PointerEvent, 'pointerId' | 'pointerType'>;
type PointerPosition = PointerIdentity &
  Pick<PointerEvent, 'clientX' | 'clientY'>;

export function createScenePinchZoom() {
  const touches = new Map<number, { x: number; y: number }>();
  const suppressedTaps = new Set<number>();

  function distance() {
    const [first, second] = touches.values();
    return second
      ? Math.max(1, Math.hypot(first.x - second.x, first.y - second.y))
      : 0;
  }

  function interrupt() {
    for (const id of touches.keys()) suppressedTaps.add(id);
    touches.clear();
  }

  return {
    begin(event: PointerPosition, disabled: boolean) {
      if (event.pointerType !== 'touch') return;
      const { pointerId, clientX, clientY } = event;
      if (disabled) {
        suppressedTaps.add(pointerId);
        return;
      }
      suppressedTaps.delete(pointerId);
      touches.set(pointerId, { x: clientX, y: clientY });
      if (touches.size >= 2)
        for (const id of touches.keys()) suppressedTaps.add(id);
    },
    move(event: PointerPosition, zoom: number) {
      if (event.pointerType !== 'touch' || !touches.has(event.pointerId))
        return;
      const previous = distance();
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const next = distance();
      if (previous && next !== previous) return zoom * (next / previous);
    },
    end(event: PointerIdentity, canceled = false) {
      if (event.pointerType !== 'touch') return;
      if (canceled && touches.has(event.pointerId)) interrupt();
      touches.delete(event.pointerId);
      suppressedTaps.delete(event.pointerId);
    },
    interrupt,
    suppressesTap(event: PointerIdentity) {
      return (
        event.pointerType === 'touch' && suppressedTaps.has(event.pointerId)
      );
    },
  };
}
