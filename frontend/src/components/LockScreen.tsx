import { useState, useEffect } from "react";
import { useAgentStore } from "../store/agentStore";
import { api } from "../lib/api";

export function LockScreen() {
  const [profiles, setProfiles] = useState<Record<string, any>>({});
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  
  const bootstrap = useAgentStore((s) => s.bootstrap);

  useEffect(() => {
    // Fetch available profiles
    fetch("/api/profiles")
      .then(res => res.json())
      .then(data => {
        setProfiles(data);
        if (Object.keys(data).length === 1) {
          setSelectedUser(Object.keys(data)[0]);
        }
      })
      .catch(err => console.error("Failed to load profiles:", err));
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUser) return;
    
    setLoading(true);
    setError("");
    
    try {
      await api.login(selectedUser, pin);
      // Wait for session to establish and bootstrap
      await bootstrap();
    } catch (err: any) {
      setError(err.message || "Invalid PIN");
    } finally {
      setLoading(false);
    }
  };

  const users = Object.keys(profiles);

  return (
    <div className="fixed inset-0 z-[9000] grid place-items-center bg-void p-4">
      <div className="flex w-full max-w-sm flex-col border-2 border-fg bg-obsidian p-6 shadow-[var(--shadow-lg)]" style={{ borderRadius: "var(--radius)" }}>
        <h2 className="type-display mb-6 text-center text-2xl text-fg">Unlock Workspace</h2>
        
        {users.length === 0 ? (
          <div className="text-center text-dim text-sm">
            <p>No profiles found.</p>
            <p className="mt-2">Please restart the app to onboard.</p>
          </div>
        ) : (
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-mono font-bold uppercase tracking-wider text-muted mb-2">
                Select Profile
              </label>
              <div className="flex flex-col gap-2">
                {users.map(u => (
                  <button
                    key={u}
                    type="button"
                    onClick={() => { setSelectedUser(u); setError(""); }}
                    className={`flex items-center justify-between p-3 rounded border-2 transition-colors ${
                      selectedUser === u ? "border-fg bg-elevated" : "border-hairline bg-void hover:border-fg"
                    }`}
                  >
                    <span className="font-medium text-fg">{profiles[u].name}</span>
                    <span className="text-xs text-muted uppercase font-mono">{profiles[u].role}</span>
                  </button>
                ))}
              </div>
            </div>

            {selectedUser && (
              <div className="animate-slide-in">
                <label className="block text-xs font-mono font-bold uppercase tracking-wider text-muted mb-2">
                  PIN
                </label>
                <input
                  type="password"
                  value={pin}
                  onChange={(e) => { setPin(e.target.value); setError(""); }}
                  placeholder="Enter PIN"
                  autoFocus
                  className="w-full rounded bg-void px-3 py-2 text-sm border-2 border-hairline outline-none focus:border-fg text-fg text-center tracking-widest text-lg"
                />
              </div>
            )}

            {error && (
              <p className="text-red-400 text-sm text-center font-medium animate-slide-in">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading || !selectedUser || !pin}
              className="btn btn-primary w-full mt-4"
            >
              {loading ? "Unlocking..." : "Unlock"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
