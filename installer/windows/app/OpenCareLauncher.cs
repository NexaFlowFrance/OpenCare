// =============================================================================
//  OpenCare : Lanceur natif (.exe) du panneau de controle
//  Edite par NexaFlow : https://nexaflow.fr
//
//  Remplace l'ancien lanceur OpenCare.vbs. Ouvre la fenetre graphique
//  (OpenCareControl.ps1) sans afficher de console PowerShell, et affiche
//  un message clair si le panneau ne parvient pas a demarrer.
//
//  Compilation (faite automatiquement par build-local.ps1) :
//    csc.exe /target:winexe /win32icon:assets\OpenCare.ico ^
//            /reference:System.Windows.Forms.dll ^
//            /out:OpenCare.exe OpenCareLauncher.cs
// =============================================================================
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

namespace OpenCare
{
    internal static class Launcher
    {
        [STAThread]
        private static int Main()
        {
            try
            {
                string appDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
                string script = Path.Combine(appDir, "OpenCareControl.ps1");

                if (!File.Exists(script))
                {
                    MessageBox.Show(
                        "Fichier introuvable :\n" + script,
                        "OpenCare", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return 1;
                }

                var psi = new ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = "-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File \"" + script + "\"",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WorkingDirectory = appDir
                };

                Process proc = Process.Start(psi);

                // Si le panneau plante immediatement (mauvaise config, droits...),
                // on previent l'utilisateur au lieu de laisser un echec silencieux.
                if (proc != null && proc.WaitForExit(4000) && proc.ExitCode != 0)
                {
                    MessageBox.Show(
                        "OpenCare n'a pas pu ouvrir le panneau de controle.\n\n" +
                        "Consultez les journaux dans :\n" +
                        "%LOCALAPPDATA%\\OpenCare\\logs",
                        "OpenCare", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return proc.ExitCode;
                }

                return 0;
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "Erreur au lancement d'OpenCare :\n\n" + ex.Message,
                    "OpenCare", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }
    }
}
