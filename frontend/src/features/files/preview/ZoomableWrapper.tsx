import { useState } from 'react';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';

// Zoomable Wrapper for mobile pinch-to-zoom using react-zoom-pan-pinch
export function ZoomableWrapper({ children, center = false }: { children: React.ReactNode, center?: boolean }) {
  const [isZoomed, setIsZoomed] = useState(false);

  return (
    <div className={`w-full h-full flex flex-col ${center ? 'items-center justify-center' : 'items-start justify-start'} overflow-hidden`}>
      <TransformWrapper
        initialScale={1}
        minScale={1}
        maxScale={4}
        centerOnInit={center}
        centerZoomedOut={center}
        limitToBounds={false}
        wheel={{ step: 0.1, activationKeys: ["Control", "Meta"] }} // Require Ctrl/Cmd to zoom on PC to restore native mouse wheel scroll
        doubleClick={{ step: 0.5 }}
        panning={{ disabled: !isZoomed, velocityDisabled: true }} // Disable JS pan when unzoomed to restore native 1-finger scroll
        alignmentAnimation={{ animationTime: 200 }}
        onZoom={(ref) => setIsZoomed(ref.state.scale > 1)}
        onZoomStop={(ref) => {
          const zoomed = ref.state.scale > 1.05; // give a slight buffer for floating point
          setIsZoomed(zoomed);
          if (!zoomed) {
            // Snap back to exactly center (x=0, y=0) when fully zoomed out
            // This fixes the issue where panning off-axis leaves blank space 
            ref.resetTransform();
          }
        }}
        onInit={(ref) => setIsZoomed(ref.state.scale > 1)}
        // `TransformWrapper` renders a hidden dom element that wraps `TransformComponent`.
        // By default it grows to `max-content`. Adding basic dimension constraint via CSS.
      >
        <TransformComponent 
          wrapperStyle={{ 
            width: '100%', 
            height: '100%', 
            // Crucial fix: DO NOT toggle overflow dynamically. 
            // It causes massive React re-renders and reflows during touch events,
            // resulting in lag, Android tearing, and iOS Safari crashes.
            overflowY: 'auto',
            overflowX: 'hidden',
            touchAction: isZoomed ? 'none' : 'pan-y' // Tell browser to natively allow vertical scroll or block it
          }} 
          contentStyle={{ 
            width: '100%', 
            minHeight: '100%', 
            display: center ? 'flex' : 'block',
            alignItems: center ? 'center' : 'flex-start',
            justifyContent: center ? 'center' : 'flex-start',
            willChange: isZoomed ? 'transform' : 'auto' 
          }}
        >
          {children}
        </TransformComponent>
      </TransformWrapper>
    </div>
  );
}
