export default function AnimatedLoader({ color = "#6366f1", size = 80 }) {
  const iconSize = Math.round(size * 0.4);
  return (
    <div style={{
      position: "relative",
      width: `${size}px`,
      height: `${size}px`,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    }}>
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes piSpin { to { transform: rotate(360deg); } }
        @keyframes piIconCycle {
          0% { opacity: 0; transform: scale(0.7) rotate(-15deg); }
          6% { opacity: 1; transform: scale(1) rotate(0deg); }
          21% { opacity: 1; transform: scale(1) rotate(0deg); }
          27% { opacity: 0; transform: scale(1.15) rotate(15deg); }
          100% { opacity: 0; }
        }
      ` }} />
      <div style={{
        position: "absolute",
        width: "100%",
        height: "100%",
        border: "3.5px solid rgba(99, 102, 241, 0.08)",
        borderTop: `3.5px solid ${color}`,
        borderRadius: "50%",
        animation: "piSpin 1.2s linear infinite",
      }} />
      <div style={{
        position: "relative",
        width: `${iconSize}px`,
        height: `${iconSize}px`,
      }}>
        {/* T-shirt SVG */}
        <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: "absolute", inset: 0, opacity: 0, animation: "piIconCycle 6s infinite ease-in-out 0s" }}>
          <path d="M20.38 3.46L16 2a4 4 0 01-8 0L3.62 3.46a2 2 0 00-1.62 1.96v4.16a2 2 0 00.56 1.39l2.4 2.4a2 2 0 002-.56l1.04-1.04v7.79a2 2 0 002 2h4a2 2 0 002-2v-7.79l1.04 1.04a2 2 0 002 .56l2.4-2.4a2 2 0 00.56-1.39V5.42a2 2 0 00-1.62-1.96z" />
        </svg>
        {/* Cap SVG */}
        <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: "absolute", inset: 0, opacity: 0, animation: "piIconCycle 6s infinite ease-in-out 1.5s" }}>
          <path d="M12 4a8 8 0 00-8 8h16a8 8 0 00-8-8z" />
          <path d="M2 12h20a1 1 0 011 1v1a4 4 0 01-4 4H5a4 4 0 01-4-4v-1a1 1 0 011-1z" />
        </svg>
        {/* Phone Cover SVG */}
        <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: "absolute", inset: 0, opacity: 0, animation: "piIconCycle 6s infinite ease-in-out 3s" }}>
          <rect x="5" y="2" width="14" height="20" rx="3" ry="3" />
          <line x1="12" y1="18" x2="12.01" y2="18" />
          <path d="M9 6h6" />
        </svg>
        {/* Bottle SVG */}
        <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: "absolute", inset: 0, opacity: 0, animation: "piIconCycle 6s infinite ease-in-out 4.5s" }}>
          <path d="M8 2h8v2H8z" />
          <path d="M9 4v3h6V4" />
          <path d="M7 8h10a1 1 0 011 1v12a2 2 0 01-2 2H8a2 2 0 01-2-2V9a1 1 0 011-1z" />
        </svg>
      </div>
    </div>
  );
}
