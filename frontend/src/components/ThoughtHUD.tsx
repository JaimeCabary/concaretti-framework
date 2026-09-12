import React from "react";
import { useAgentStore } from "../store/agentStore";

export function ThoughtHUD() {
  const { streamingText, events } = useAgentStore();
  
  // Find the latest active thought or subtask
  const latestThought = React.useMemo(() => {
    if (streamingText) return streamingText;
    
    // Look backwards through events for the latest thought or subtask
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === "thought" || e.type === "subtask") {
        return e.content;
      }
    }
    
    return "Idle. Waiting for instructions...";
  }, [streamingText, events]);

  return (
    <div style={{
      width: "100%",
      height: "100vh",
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "center",
      paddingTop: "20px",
      // Completely transparent background to let the desktop show through
      backgroundColor: "transparent",
      // Drag region for Tauri
      WebkitAppRegion: "drag",
    } as React.CSSProperties}>
      <div style={{
        background: "rgba(10, 10, 15, 0.85)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        border: "1px solid rgba(255, 255, 255, 0.1)",
        borderRadius: "16px",
        padding: "16px 24px",
        color: "#fff",
        fontFamily: "'DM Sans Variable', sans-serif",
        fontSize: "16px",
        maxWidth: "600px",
        boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
        display: "flex",
        alignItems: "center",
        gap: "12px",
      }}>
        <div style={{
          width: "8px",
          height: "8px",
          borderRadius: "50%",
          background: streamingText ? "#00FF99" : "#666",
          boxShadow: streamingText ? "0 0 10px #00FF99" : "none",
          flexShrink: 0
        }} />
        <div style={{
          lineHeight: "1.4",
          overflow: "hidden",
          textOverflow: "ellipsis",
          display: "-webkit-box",
          WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical",
        }}>
          {latestThought}
        </div>
      </div>
    </div>
  );
}
