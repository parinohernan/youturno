import { useEffect, useRef, useState } from "preact/hooks";

const TILE_SIZE = 256;
const MIN_ZOOM = 2;
const MAX_ZOOM = 19;
const DEFAULT_CENTER = { lat: -34.6037, lng: -58.3816 };
const DEFAULT_ZOOM = 12;
const MAX_LATITUDE = 85.05112878;

export function lngToWorldX(lng: number, zoom: number): number { return (lng + 180) / 360 * TILE_SIZE * 2 ** zoom; }
export function latToWorldY(lat: number, zoom: number): number {
  const rad = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + rad / 2)) / Math.PI) / 2 * TILE_SIZE * 2 ** zoom;
}
export function worldXToLng(x: number, zoom: number): number { return x / (TILE_SIZE * 2 ** zoom) * 360 - 180; }
export function worldYToLat(y: number, zoom: number): number {
  const n = Math.PI - 2 * Math.PI * y / (TILE_SIZE * 2 ** zoom);
  return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export function CompanyLocationPicker({ latitude, longitude, onChange, disabled = false }: {
  latitude: number | null; longitude: number | null;
  onChange: (latitude: number, longitude: number) => void;
  disabled?: boolean;
}) {
  const hasLocation = latitude != null && longitude != null;
  const [center, setCenter] = useState(hasLocation ? { lat: latitude, lng: longitude } : DEFAULT_CENTER);
  const [zoom, setZoom] = useState(hasLocation ? 15 : DEFAULT_ZOOM);
  const [marker, setMarker] = useState(hasLocation ? { lat: latitude, lng: longitude } : null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const container = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; center: typeof center; moved: boolean } | null>(null);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const worldSize = TILE_SIZE * 2 ** zoom;
  const worldX = lngToWorldX(center.lng, zoom);
  const worldY = latToWorldY(Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, center.lat)), zoom);
  const wrapX = (x: number) => ((x % worldSize) + worldSize) % worldSize;
  const panTo = (x: number, y: number) => setCenter({
    lng: worldXToLng(wrapX(x), zoom),
    lat: worldYToLat(Math.max(0, Math.min(worldSize, y)), zoom),
  });
  const changeZoom = (next: number) => setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next)));

  const firstX = Math.floor((worldX - size.width / 2) / TILE_SIZE);
  const lastX = Math.floor((worldX + size.width / 2) / TILE_SIZE);
  const firstY = Math.max(0, Math.floor((worldY - size.height / 2) / TILE_SIZE));
  const lastY = Math.min(2 ** zoom - 1, Math.floor((worldY + size.height / 2) / TILE_SIZE));
  const tiles = [];
  if (size.width && size.height) {
    for (let x = firstX; x <= lastX; x++) {
      for (let y = firstY; y <= lastY; y++) {
        const wrappedX = ((x % (2 ** zoom)) + 2 ** zoom) % (2 ** zoom);
        tiles.push(<img key={`${x}/${y}`} alt="" draggable={false} className="pointer-events-none absolute max-w-none"
          style={{ width: TILE_SIZE, height: TILE_SIZE,
            left: x * TILE_SIZE - worldX + size.width / 2,
            top: y * TILE_SIZE - worldY + size.height / 2 }}
          src={`https://tile.openstreetmap.org/${zoom}/${wrappedX}/${y}.png`} />);
      }
    }
  }
  let markerLeft = 0;
  let markerTop = 0;
  if (marker) {
    const deltaX = lngToWorldX(marker.lng, zoom) - worldX;
    markerLeft = size.width / 2 + deltaX - Math.round(deltaX / worldSize) * worldSize;
    markerTop = size.height / 2 + latToWorldY(Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, marker.lat)), zoom) - worldY;
  }

  return <div ref={container} role="application" aria-label="Mapa para marcar la ubicación del negocio"
    className="relative h-64 w-full touch-none cursor-crosshair overflow-hidden rounded-md border border-border bg-muted"
    onPointerDown={(event) => {
      if (disabled || event.button !== 0 || (event.target as HTMLElement).closest("button, a")) return;
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, center, moved: false };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={(event) => {
      const start = drag.current;
      if (disabled || !start || start.id !== event.pointerId) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (Math.hypot(dx, dy) > 4) start.moved = true;
      if (start.moved) {
        panTo(lngToWorldX(start.center.lng, zoom) - dx,
          latToWorldY(Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, start.center.lat)), zoom) - dy);
      }
    }}
    onPointerUp={(event) => {
      const start = drag.current;
      if (!start || start.id !== event.pointerId) return;
      drag.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      if (disabled || start.moved) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      const x = wrapX(lngToWorldX(start.center.lng, zoom) + event.clientX - bounds.left - bounds.width / 2);
      const y = Math.max(0, Math.min(worldSize,
        latToWorldY(Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, start.center.lat)), zoom) + event.clientY - bounds.top - bounds.height / 2));
      const lat = worldYToLat(y, zoom);
      const lng = worldXToLng(x, zoom);
      setMarker({ lat, lng });
      onChange(lat, lng);
    }}
    onPointerCancel={() => { drag.current = null; }}
    onWheel={(event) => {
      if (disabled) return;
      event.preventDefault();
      changeZoom(zoom + (event.deltaY < 0 ? 1 : -1));
    }}>
    {tiles}
    {marker && <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full drop-shadow-md"
      style={{ left: markerLeft, top: markerTop }} aria-hidden="true">
      <svg width="32" height="42" viewBox="0 0 32 42" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M16 40S2 24.7 2 16a14 14 0 1 1 28 0c0 8.7-14 24-14 24Z" fill="#b84332" stroke="white" stroke-width="2" />
        <circle cx="16" cy="16" r="5" fill="white" />
      </svg>
    </div>}
    <div className="absolute right-2 top-2 z-20 flex flex-col overflow-hidden rounded-md border border-border bg-background shadow-sm">
      <button type="button" aria-label="Acercar mapa" disabled={disabled || zoom >= MAX_ZOOM}
        className="h-9 w-9 text-xl leading-none hover:bg-muted disabled:opacity-50" onClick={() => changeZoom(zoom + 1)}>+</button>
      <button type="button" aria-label="Alejar mapa" disabled={disabled || zoom <= MIN_ZOOM}
        className="h-9 w-9 border-t border-border text-xl leading-none hover:bg-muted disabled:opacity-50" onClick={() => changeZoom(zoom - 1)}>−</button>
    </div>
    <a className="absolute bottom-1 right-1 z-20 rounded bg-background/90 px-1.5 py-0.5 text-[10px] text-foreground underline"
      href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>
  </div>;
}
