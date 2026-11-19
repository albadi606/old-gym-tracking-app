import os
import sys
import time
import shutil
import subprocess
import webbrowser
import urllib.request
from pathlib import Path

PORT = 5173
URL = f"http://localhost:{PORT}/"
PROJECT_DIR = Path(__file__).resolve().parent

def find_package_manager():
    # Prefer pnpm since package.json specifies pnpm
    for pm in ["pnpm", "npm"]:
        if shutil.which(pm):
            return pm
    return None

def wait_for_server(url, timeout=15):
    """Wait until the dev server responds on the given URL."""
    start = time.time()
    while time.time() - start < timeout:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return True
        except Exception:
            time.sleep(0.5)
    return False

def main():
    os.chdir(PROJECT_DIR)
    pm = find_package_manager()
    if not pm:
        print("❌ Error: Neither 'pnpm' nor 'npm' was found in your PATH.")
        input("Press Enter to exit...")
        sys.exit(1)

    print(f"🚀 Starting Gym Tracker using {pm}...")
    cmd = [pm, "run", "dev"] if pm == "npm" else [pm, "dev"]

    # On Windows, shell=True ensures pnpm.cmd / npm.cmd is invoked properly
    proc = subprocess.Popen(
        cmd,
        cwd=PROJECT_DIR,
        shell=(sys.platform == "win32")
    )

    try:
        print(f"⏳ Waiting for Vite dev server at {URL}...")
        if wait_for_server(URL):
            print(f"✅ Server is ready! Opening {URL} in your browser...")
        else:
            print(f"⚠️ Opening {URL} (server still loading)...")

        webbrowser.open(URL)
        print("\n💡 App is running. Press Ctrl+C in this window to stop the server.\n")
        proc.wait()

    except KeyboardInterrupt:
        print("\n🛑 Shutting down Gym Tracker...")
    finally:
        if proc.poll() is None:
            if sys.platform == "win32":
                # Kill the entire process tree so node.exe doesn't linger
                subprocess.call(
                    ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL
                )
            else:
                proc.terminate()
        print("👋 Server stopped.")

if __name__ == "__main__":
    main()
