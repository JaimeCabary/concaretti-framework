import os
import re
from pathlib import Path
from dotenv import load_dotenv

try:
    from google_auth_oauthlib.flow import InstalledAppFlow
except ImportError:
    print("Missing dependencies. Please run this script with uv from the backend directory:")
    print("uv run python google_auth_flow.py")
    exit(1)

# Load existing .env
env_path = Path(__file__).parent / ".env"
load_dotenv(env_path)

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/calendar",
]

def update_env_file(env_path: Path, client_id: str, client_secret: str, refresh_token: str):
    content = ""
    if env_path.exists():
        content = env_path.read_text(encoding="utf-8")
    
    def set_key(text: str, key: str, value: str) -> str:
        pattern = re.compile(rf"^{key}=.*$", re.MULTILINE)
        if pattern.search(text):
            return pattern.sub(f"{key}={value}", text)
        else:
            if text and not text.endswith("\n"):
                text += "\n"
            return text + f"{key}={value}\n"
            
    content = set_key(content, "GOOGLE_CLIENT_ID", client_id)
    content = set_key(content, "GOOGLE_CLIENT_SECRET", client_secret)
    content = set_key(content, "GOOGLE_REFRESH_TOKEN", refresh_token)
    
    env_path.write_text(content, encoding="utf-8")

def main():
    print("=" * 60)
    print(" Google Workspace OAuth Setup ")
    print("=" * 60)
    print("Your current GOOGLE_REFRESH_TOKEN is expired or invalid (invalid_grant).")
    print("This script will generate a new one for you.\n")
    
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "")
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET", "")
    
    if not client_id or client_id.startswith("YOUR_"):
        client_id = input("Enter your Google Client ID: ").strip()
    else:
        print(f"[+] Loaded Client ID from .env: {client_id[:15]}...")
        
    if not client_secret or client_secret.startswith("YOUR_"):
        client_secret = input("Enter your Google Client Secret: ").strip()
    else:
        print("[+] Loaded Client Secret from .env: ********")
    
    if not client_id or not client_secret:
        print("Client ID and Secret are required. Exiting.")
        return
        
    client_config = {
        "installed": {
            "client_id": client_id,
            "client_secret": client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
            "redirect_uris": ["http://localhost"]
        }
    }
    
    print("\n[!] CRITICAL STEP: Please ensure you have added 'http://localhost:12345/'")
    print("    to the 'Authorized redirect URIs' list in your Google Cloud Console for this Client ID.")
    print("Opening your browser to authenticate...")
    try:
        flow = InstalledAppFlow.from_client_config(client_config, SCOPES)
        creds = flow.run_local_server(port=12345)
    except Exception as e:
        print(f"\n[!] Failed to authenticate: {e}")
        return
        
    if creds and creds.refresh_token:
        update_env_file(env_path, client_id, client_secret, creds.refresh_token)
        print("\n[+] Success! Your new GOOGLE_REFRESH_TOKEN has been saved to backend/.env")
        print("[+] You can now close this script and use the Email and Calendar features in Concaretti.")
    else:
        print("\n[!] Failed to get a refresh token. This usually happens if the app was already authorized.")
        print("    Try going to your Google Account Settings > Security > Third-party apps with account access,")
        print("    remove the app, and run this script again.")

if __name__ == "__main__":
    main()
