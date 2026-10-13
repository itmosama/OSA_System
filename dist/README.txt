OSA License Tool (vendor-only)
==============================

Files on the PC where you use it, all in the SAME folder:

  license-tool.exe          the program (this file)
  license-private-key.pem   your signing key  -- copy it here yourself
  .env                      created by the set-password step below
  licenses.json             created automatically; your history of issued licenses

SECURITY: license-private-key.pem is what makes licenses valid. Only put it on
PCs you personally trust. Never copy it (or this tool) to a client's PC.

First-time setup on a new PC
----------------------------
1. Copy license-tool.exe and license-private-key.pem into one folder.
2. Open Command Prompt in that folder and set a password (8+ characters):

       license-tool.exe set-password "your-password"

3. Double-click license-tool.exe. A console window opens and your browser
   goes to http://localhost:4100. Sign in with the password from step 2.
4. Keep the console window open while you work. Close it to stop the tool.

To carry your issued-license history to another PC, also copy licenses.json.
To change the password later, run step 2 again and restart the tool.
The tool only listens on this PC (localhost); it is not reachable from the network.
