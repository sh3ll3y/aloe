import { DndContext, DragEndEvent, DragStartEvent, DragOverlay, PointerSensor, useSensor, useSensors, closestCenter } from '@dnd-kit/core';
import { SortableContext, useSortable, rectSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { RotationDirection } from '../utils/pdfUtils';
import type { CSSProperties } from 'react';
import React, { memo, useMemo, useState } from 'react';

export interface PageThumbnailData {
  id: string;
  /** 1-based page number for display. */
  pageNumber: number;
  /** Data URL representing the rendered page image. */
  previewUrl: string;
  /** Rotation in degrees applied to the page. */
  rotation: number;
  /** Hex/CSS color indicating the document group. */
  groupColor?: string;
  /** text status for page: 'native'|'ocr'|'none' */
  textTag?: 'native' | 'ocr' | 'none';
}

interface ThumbnailGridProps {
  pages: PageThumbnailData[];
  onReorder: (sourceIndex: number, destinationIndex: number) => void;
  onRotate: (id: string, direction: RotationDirection) => void;
  onDelete: (id: string) => void;
  onSelect?: (id: string) => void;
  selectedId?: string;
  highlightedIds?: Set<string>;
}

/**
 * Displays draggable page thumbnails with quick actions.
 */
export function ThumbnailGrid({ pages, onReorder, onRotate, onDelete, onSelect, selectedId, highlightedIds }: ThumbnailGridProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [activeId, setActiveId] = useState<string | null>(null);

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      setActiveId(null);
      return;
    }
    const fromIndex = pages.findIndex((p) => p.id === String(active.id));
    const toIndex = pages.findIndex((p) => p.id === String(over.id));
    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
      setActiveId(null);
      return;
    }
    onReorder(fromIndex, toIndex);
    setActiveId(null);
  };

  const activePage = useMemo(() => pages.find((p) => p.id === activeId) || null, [pages, activeId]);

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <SortableContext items={pages.map((p) => p.id)} strategy={rectSortingStrategy}>
        <div className="flex flex-wrap content-start rounded-2xl border border-[var(--aloe-border)] bg-[var(--aloe-surface)] p-4 shadow-sm">
          {pages.map((page) => (
            <SortableItem
              key={page.id}
              page={page}
              onRotate={onRotate}
              onDelete={onDelete}
              onSelect={onSelect}
              selected={selectedId === page.id}
              highlighted={highlightedIds?.has(page.id) ?? false}
            />
          ))}
        </div>
      </SortableContext>
      <DragOverlay dropAnimation={{ duration: 150, easing: 'ease-out' }}>
        {activePage ? <SortableItemContent page={activePage} draggingOverlay /> : null}
      </DragOverlay>
    </DndContext>
  );
}

const SortableItem = memo(function SortableItem({ page, onRotate, onDelete, onSelect, selected, highlighted }: { page: PageThumbnailData; onRotate: ThumbnailGridProps['onRotate']; onDelete: ThumbnailGridProps['onDelete']; onSelect?: ThumbnailGridProps['onSelect']; selected?: boolean; highlighted?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: page.id });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    willChange: 'transform',
    zIndex: isDragging ? 50 : 'auto',
    opacity: isDragging ? 0.2 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => onSelect?.(page.id)}
      role={onSelect ? 'button' : undefined}
    >
      <SortableItemContent page={page} withControls onRotate={onRotate} onDelete={onDelete} selected={selected} highlighted={highlighted} />
    </div>
  );
});

const SortableItemContent = memo(function SortableItemContent({ page, draggingOverlay = false, withControls = false, onRotate, onDelete, selected = false, highlighted = false }: { page: PageThumbnailData; draggingOverlay?: boolean; withControls?: boolean; onRotate?: ThumbnailGridProps['onRotate']; onDelete?: ThumbnailGridProps['onDelete']; selected?: boolean; highlighted?: boolean }) {
  const baseClasses =
    'm-2 box-border flex w-32 cursor-pointer flex-col items-center gap-2 rounded-xl border border-[var(--aloe-border)] bg-[var(--aloe-surface-muted)] p-2 text-center shadow-sm transition will-change-transform';
  const activeClasses = draggingOverlay ? ' border-[var(--aloe-accent)] shadow-xl z-50' : '';
  const stateClasses = selected
    ? ' border-[var(--aloe-accent)] shadow-lg'
    : highlighted
      ? ' border-[var(--aloe-primary)] border-dashed bg-[var(--aloe-primary-soft)]/60'
      : '';
  const containerStyle: CSSProperties = { borderColor: page.groupColor };
  return (
    <div className={`${baseClasses}${activeClasses}${stateClasses}`} style={containerStyle}>
      <div className="relative h-36 w-full overflow-hidden rounded-lg bg-[var(--aloe-accent-soft)]">
        {page.textTag ? (
          <span className="absolute left-1 top-1 rounded-full bg-[var(--aloe-surface)]/85 px-2 py-[2px] text-[10px] font-semibold text-[var(--aloe-text-secondary)] shadow-sm">
            {page.textTag}
          </span>
        ) : null}
        <img src={page.previewUrl} alt={`Page ${page.pageNumber}`} style={{ transform: `rotate(${page.rotation}deg)` }} className="h-full w-full object-contain" />
      </div>
      <span className="text-xs font-semibold text-[var(--aloe-text-secondary)]">Page {page.pageNumber}</span>
      {withControls && onRotate && onDelete ? (
        <div className="flex items-center gap-2">
          <button type="button" aria-label="Rotate counterclockwise" title="Rotate counterclockwise" className="btn-neu btn-neu--sm" onClick={(e) => { e.stopPropagation(); onRotate(page.id, 'counterclockwise'); }}>
            ⟲
          </button>
          <button type="button" aria-label="Rotate clockwise" title="Rotate clockwise" className="btn-neu btn-neu--sm" onClick={(e) => { e.stopPropagation(); onRotate(page.id, 'clockwise'); }}>
            ⟳
          </button>
          <button type="button" aria-label="Delete page" title="Delete page" className="btn-neu btn-neu--sm" onClick={(e) => { e.stopPropagation(); onDelete(page.id); }}>
            ✖
          </button>
        </div>
      ) : null}
    </div>
  );
});
