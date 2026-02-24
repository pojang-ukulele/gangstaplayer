const { app } = require('electron');
const path = require('path');
const fs = require('fs');

app.whenReady().then(() => {
    console.log('--- SYSTEM INFO ---');
    console.log('Electron:', process.versions.electron);
    console.log('Node:', process.versions.node);
    console.log('Modules:', process.versions.modules);
    
    try {
        const sqlite = require('better-sqlite3');
        console.log('better-sqlite3: LOADED');
    } catch (e) {
        console.log('better-sqlite3: FAILED');
        console.log('Error:', e.message);
    }
    app.quit();
});
