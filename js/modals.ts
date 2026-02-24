/**
 * Reusable UI Modal Utilities
 */

// UI Helper for Confirmation
export function showConfirm(title: string, message: string, onYes: () => void): void {
    const modal = document.getElementById('confirmModal');
    if (!modal) return;
    
    document.getElementById('confirmTitle')!.innerText = title;
    document.getElementById('confirmMessage')!.innerText = message;
    
    // Cleanup old listeners to prevent double-firing
    const yesBtn = document.getElementById('confirmYes')!;
    const newYes = yesBtn.cloneNode(true);
    yesBtn.parentNode!.replaceChild(newYes, yesBtn);
    
    const noBtn = document.getElementById('confirmNo')!;
    const newNo = noBtn.cloneNode(true);
    noBtn.parentNode!.replaceChild(newNo, noBtn);

    const close = () => { modal.style.display = 'none'; };
    
    newNo.addEventListener('click', close);
    newYes.addEventListener('click', () => {
        close();
        onYes();
    });

    modal.style.display = 'block';
}
