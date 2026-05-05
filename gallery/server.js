const express = require('express');
const multer = require('multer');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3000;

// Create directories
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

[DATA_DIR, UPLOADS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

if (!fs.existsSync(PUBLIC_DIR)) {
    fs.mkdirSync(PUBLIC_DIR, { recursive: true });
}

let db;

async function initDb() {
    const sqlJs = await initSqlJs();
    const Database = sqlJs.Database;
    const dbPath = path.join(DATA_DIR, 'gallery.db');
    
    if (fs.existsSync(dbPath)) {
        db = new Database(fs.readFileSync(dbPath));
        // Migration: add new columns if they don't exist
        const columns = db.exec("PRAGMA table_info(galleries)")[0]?.values.map(r => r[1]) || [];
        const migrations = [
            ['cover_photo', 'TEXT'],
            ['expires_color', 'TEXT'],
            ['font_title', "TEXT DEFAULT 'Inter'"],
            ['font_date', "TEXT DEFAULT 'Inter'"],
            ['title_color', "TEXT DEFAULT '#ffffff'"],
            ['date_color', "TEXT DEFAULT '#ffffff'"],
            ['title_opacity', 'INTEGER DEFAULT 100'],
            ['date_opacity', 'INTEGER DEFAULT 100'],
            ['cover_position', "TEXT DEFAULT 'center'"],
            ['title_size', 'INTEGER DEFAULT 48'],
            ['date_size', 'INTEGER DEFAULT 16'],
            ['border_radius', 'INTEGER DEFAULT 0'],
            ['show_title', 'INTEGER DEFAULT 1'],
            ['show_date', 'INTEGER DEFAULT 0']
        ];
        migrations.forEach(([col, type]) => {
            if (!columns.includes(col)) {
                db.run(`ALTER TABLE galleries ADD COLUMN ${col} ${type}`);
            }
        });
        
        // Migration: add category_id to photos table
        const photoColumns = db.exec("PRAGMA table_info(photos)")[0]?.values.map(r => r[1]) || [];
        if (!photoColumns.includes('category_id')) {
            db.run(`ALTER TABLE photos ADD COLUMN category_id TEXT`);
        }
        
        // Migration: create categories table if not exists
        const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values.map(r => r[0]) || [];
        if (!tables.includes('categories')) {
            db.run(`
                CREATE TABLE categories (
                    id TEXT PRIMARY KEY,
                    gallery_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    cover_photo TEXT,
                    position INTEGER DEFAULT 0,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (gallery_id) REFERENCES galleries(id)
                )
            `);
        }
    } else {
        db = new Database();
        // Admins table
        db.run(`
            CREATE TABLE admins (
                id TEXT PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        `);
        // Galleries table (linked to admin)
        db.run(`
            CREATE TABLE galleries (
                id TEXT PRIMARY KEY,
                admin_id TEXT NOT NULL,
                title TEXT NOT NULL,
                cover_photo TEXT,
                expires_color TEXT,
                font_title TEXT DEFAULT 'Inter',
                font_date TEXT DEFAULT 'Inter',
                title_color TEXT DEFAULT '#ffffff',
                date_color TEXT DEFAULT '#ffffff',
                title_opacity INTEGER DEFAULT 100,
                date_opacity INTEGER DEFAULT 100,
                cover_position TEXT DEFAULT 'center',
                title_size INTEGER DEFAULT 48,
                date_size INTEGER DEFAULT 16,
                border_radius INTEGER DEFAULT 0,
                show_title INTEGER DEFAULT 1,
                show_date INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                expires_at TEXT,
                FOREIGN KEY (admin_id) REFERENCES admins(id)
            )
        `);
        // Photos table
        db.run(`
            CREATE TABLE photos (
                id TEXT PRIMARY KEY,
                gallery_id TEXT NOT NULL,
                category_id TEXT,
                filename TEXT NOT NULL,
                original_name TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (gallery_id) REFERENCES galleries(id)
            )
        `);
        
        // Categories table
        db.run(`
            CREATE TABLE categories (
                id TEXT PRIMARY KEY,
                gallery_id TEXT NOT NULL,
                name TEXT NOT NULL,
                cover_photo TEXT,
                position INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (gallery_id) REFERENCES galleries(id)
            )
        `);
    }
    saveDb();
}

function saveDb() {
    const data = db.export();
    fs.writeFileSync(path.join(DATA_DIR, 'gallery.db'), Buffer.from(data));
}

function dbRun(sql, params = []) {
    db.run(sql, params);
    saveDb();
}

function dbGet(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        return row;
    }
    stmt.free();
    return null;
}

function dbAll(sql, params = []) {
    const results = [];
    const stmt = db.prepare(sql);
    stmt.bind(params);
    while (stmt.step()) {
        results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
}

// Serve static files
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.json());

// Multer config
const storage = multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => {
        const uniqueId = crypto.randomUUID();
        const ext = path.extname(file.originalname);
        cb(null, `${uniqueId}${ext}`);
    }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

function generateId() {
    return crypto.randomBytes(4).toString('hex');
}

// Check if gallery is expired
function isGalleryExpired(expiresAt) {
    if (!expiresAt) return false;
    return new Date(expiresAt) < new Date();
}

// Cleanup expired galleries (runs once a day at midnight)
function startCleanupScheduler() {
    // Run cleanup every 24 hours
    setInterval(() => {
        const galleries = dbAll('SELECT id, admin_id, expires_at FROM galleries WHERE expires_at IS NOT NULL');
        const now = new Date();
        
        galleries.forEach(g => {
            if (new Date(g.expires_at) < now) {
                console.log(`Cleaning up expired gallery: ${g.id}`);
                
                // Delete all photos
                const photos = dbAll('SELECT filename FROM photos WHERE gallery_id = ?', [g.id]);
                photos.forEach(p => {
                    const filePath = path.join(UPLOADS_DIR, p.filename);
                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                });
                
                dbRun('DELETE FROM photos WHERE gallery_id = ?', [g.id]);
                dbRun('DELETE FROM galleries WHERE id = ?', [g.id]);
            }
        });
    }, 86400000); // 24 hours
}

// Simple hash (in production use bcrypt)
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

// === ADMIN AUTH ROUTES ===

// Register admin
app.post('/api/admin/register', (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ error: 'Email та пароль обов\'язкові' });
    }
    
    const existing = dbGet('SELECT id FROM admins WHERE email = ?', [email]);
    if (existing) {
        return res.status(400).json({ error: 'Користувач з таким email вже існує' });
    }
    
    const id = generateId();
    const passwordHash = hashPassword(password);
    
    dbRun('INSERT INTO admins (id, email, password_hash) VALUES (?, ?, ?)', [id, email, passwordHash]);
    
    res.json({ id, email });
});

// Login admin
app.post('/api/admin/login', (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ error: 'Email та пароль обов\'язкові' });
    }
    
    const admin = dbGet('SELECT * FROM admins WHERE email = ?', [email]);
    
    if (!admin || admin.password_hash !== hashPassword(password)) {
        return res.status(401).json({ error: 'Неправильний email або пароль' });
    }
    
    res.json({ id: admin.id, email: admin.email });
});

// Get admin galleries
app.get('/api/admin/:adminId/galleries', (req, res) => {
    const adminId = req.params.adminId;
    const authHeader = req.headers['x-session-token'];
    
    const admin = dbGet('SELECT id FROM admins WHERE id = ?', [adminId]);
    if (!admin || authHeader !== adminId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const galleries = dbAll('SELECT id, title, created_at, expires_at, cover_photo, expires_color, font_title, font_date, title_color, date_color, title_opacity, date_opacity, cover_position, title_size, date_size, border_radius, show_title, show_date FROM galleries WHERE admin_id = ? ORDER BY created_at DESC', [adminId]);
    
    // Add photo count and expired status
    const result = galleries.map(g => {
        const photos = dbAll('SELECT id FROM photos WHERE gallery_id = ?', [g.id]);
        return { 
            ...g, 
            photo_count: photos.length,
            expired: isGalleryExpired(g.expires_at)
        };
    });
    
    res.json(result);
});

// === GALLERY ROUTES ===

// Create gallery
// Multer for gallery creation (with optional cover photo)
const galleryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.post('/api/galleries', galleryUpload.single('coverPhoto'), (req, res) => {
    const { adminId, title, expiresAt, expiresColor, fontTitle, fontDate, titleColor, dateColor, titleOpacity, dateOpacity, coverPosition, titleSize, dateSize, borderRadius, showTitle, showDate } = req.body;
    
    if (!adminId || !title) {
        return res.status(400).json({ error: 'Всі поля обов\'язкові' });
    }
    
    const admin = dbGet('SELECT id FROM admins WHERE id = ?', [adminId]);
    if (!admin) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const id = generateId();
    let coverPhotoUrl = null;
    
    if (req.file) {
        const ext = path.extname(req.file.originalname);
        const filename = `${id}_cover${ext}`;
        const filePath = path.join(UPLOADS_DIR, filename);
        fs.writeFileSync(filePath, req.file.buffer);
        coverPhotoUrl = `/uploads/${filename}`;
    }
    
    dbRun(`INSERT INTO galleries (id, admin_id, title, cover_photo, expires_color, font_title, font_date, title_color, date_color, title_opacity, date_opacity, cover_position, title_size, date_size, border_radius, show_title, show_date, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
        [id, adminId, title, coverPhotoUrl, expiresColor || '#888888', fontTitle || 'Inter', fontDate || 'Inter', titleColor || '#ffffff', dateColor || '#ffffff', titleOpacity || 100, dateOpacity || 100, coverPosition || 'center', titleSize || 48, dateSize || 16, borderRadius || 0, showTitle !== undefined ? showTitle : 1, showDate !== undefined ? showDate : 0, expiresAt || null]);
    
    res.json({ id, title, cover_photo: coverPhotoUrl, expires_color: expiresColor || '#888888', expires_at: expiresAt });
});

// Get gallery info (public)
app.get('/api/gallery/:id', (req, res) => {
    const gallery = dbGet('SELECT id, title, created_at, expires_at, cover_photo, expires_color, font_title, font_date, title_color, date_color, title_opacity, date_opacity, cover_position, title_size, date_size, border_radius, show_title, show_date FROM galleries WHERE id = ?', [req.params.id]);
    
    if (!gallery) {
        return res.status(404).json({ error: 'Галерея не знайдена' });
    }
    
    // Check if gallery is expired
    if (isGalleryExpired(gallery.expires_at)) {
        return res.status(410).json({ error: 'Галерея більше недоступна', expired: true });
    }
    
    const photos = dbAll('SELECT id, filename, original_name, category_id, created_at FROM photos WHERE gallery_id = ? ORDER BY created_at DESC', [req.params.id]);
    const categories = dbAll('SELECT id, name, cover_photo, position FROM categories WHERE gallery_id = ? ORDER BY position ASC, created_at ASC', [req.params.id]);
    
    // Calculate photo counts for each category
    const categoriesWithCounts = categories.map(c => {
        const count = photos.filter(p => p.category_id === c.id).length;
        return { ...c, photo_count: count };
    });
    
    res.json({ ...gallery, photos, categories: categoriesWithCounts, expired: false });
});

// Upload photo (admin only)
app.post('/api/gallery/:id/photos', (req, res) => {
    const galleryId = req.params.id;
    const sessionToken = req.headers['x-session-token'];
    
    const gallery = dbGet('SELECT admin_id FROM galleries WHERE id = ?', [galleryId]);
    
    if (!gallery) {
        return res.status(404).json({ error: 'Галерея не знайдена' });
    }
    
    if (sessionToken !== gallery.admin_id) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    upload.single('photo')(req, res, (err) => {
        if (err) {
            return res.status(400).json({ error: err.message });
        }
        
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        const photoId = path.basename(req.file.filename, path.extname(req.file.filename));
        const originalName = req.file.originalname;
        const categoryId = req.body.categoryId || null;
        
        dbRun('INSERT INTO photos (id, gallery_id, category_id, filename, original_name) VALUES (?, ?, ?, ?, ?)', 
            [photoId, galleryId, categoryId, req.file.filename, originalName]);
        
        res.json({ id: photoId, filename: req.file.filename, original_name: originalName, category_id: categoryId });
    });
});

// Create category
app.post('/api/gallery/:id/categories', (req, res) => {
    const galleryId = req.params.id;
    const sessionToken = req.headers['x-session-token'];
    const { name, position } = req.body;
    
    const gallery = dbGet('SELECT admin_id FROM galleries WHERE id = ?', [galleryId]);
    
    if (!gallery) {
        return res.status(404).json({ error: 'Галерея не знайдена' });
    }
    
    if (sessionToken !== gallery.admin_id) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    if (!name) {
        return res.status(400).json({ error: 'Назва категорії обов\'язкова' });
    }
    
    const categoryId = generateId();
    dbRun('INSERT INTO categories (id, gallery_id, name, position) VALUES (?, ?, ?, ?)', 
        [categoryId, galleryId, name, position || 0]);
    
    res.json({ id: categoryId, name, position: position || 0 });
});

// Get categories for gallery
app.get('/api/gallery/:id/categories', (req, res) => {
    const galleryId = req.params.id;
    
    const categories = dbAll('SELECT id, name, cover_photo, position, created_at FROM categories WHERE gallery_id = ? ORDER BY position ASC, created_at ASC', [galleryId]);
    
    // Add photo count to each category
    const result = categories.map(c => {
        const photos = dbAll('SELECT id FROM photos WHERE category_id = ?', [c.id]);
        return { ...c, photo_count: photos.length };
    });
    
    res.json(result);
});

// Delete category
app.delete('/api/categories/:id', (req, res) => {
    const categoryId = req.params.id;
    const sessionToken = req.headers['x-session-token'];
    
    const category = dbGet('SELECT c.*, g.admin_id FROM categories c JOIN galleries g ON c.gallery_id = g.id WHERE c.id = ?', [categoryId]);
    
    if (!category) {
        return res.status(404).json({ error: 'Категорію не знайдено' });
    }
    
    if (sessionToken !== category.admin_id) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Move photos from this category to uncategorized
    dbRun('UPDATE photos SET category_id = NULL WHERE category_id = ?', [categoryId]);
    dbRun('DELETE FROM categories WHERE id = ?', [categoryId]);
    
    res.json({ success: true });
});

// Upload cover photo
app.post('/api/gallery/:id/cover', (req, res) => {
    const galleryId = req.params.id;
    const sessionToken = req.headers['x-session-token'];
    
    const gallery = dbGet('SELECT admin_id FROM galleries WHERE id = ?', [galleryId]);
    
    if (!gallery) {
        return res.status(404).json({ error: 'Галерея не знайдена' });
    }
    
    if (sessionToken !== gallery.admin_id) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    upload.single('cover')(req, res, (err) => {
        if (err) {
            return res.status(400).json({ error: err.message });
        }
        
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        const coverUrl = `/uploads/${req.file.filename}`;
        dbRun('UPDATE galleries SET cover_photo = ? WHERE id = ?', [coverUrl, galleryId]);
        
        res.json({ cover_photo: coverUrl });
    });
});

app.delete('/api/gallery/:id/cover', (req, res) => {
    const galleryId = req.params.id;
    const sessionToken = req.headers['x-session-token'];
    
    const gallery = dbGet('SELECT admin_id, cover_photo FROM galleries WHERE id = ?', [galleryId]);
    
    if (!gallery) {
        return res.status(404).json({ error: 'Галерея не знайдена' });
    }
    
    if (sessionToken !== gallery.admin_id) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    dbRun('UPDATE galleries SET cover_photo = NULL WHERE id = ?', [galleryId]);
    res.json({ success: true });
});

// Delete photo (admin only)
app.delete('/api/gallery/:id/photos/:photoId', (req, res) => {
    const { id: galleryId, photoId } = req.params;
    const sessionToken = req.headers['x-session-token'];
    
    const gallery = dbGet('SELECT admin_id FROM galleries WHERE id = ?', [galleryId]);
    
    if (!gallery || sessionToken !== gallery.admin_id) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const photo = dbGet('SELECT filename FROM photos WHERE id = ? AND gallery_id = ?', [photoId, galleryId]);
    
    if (!photo) {
        return res.status(404).json({ error: 'Photo not found' });
    }
    
    const filePath = path.join(UPLOADS_DIR, photo.filename);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
    
    dbRun('DELETE FROM photos WHERE id = ?', [photoId]);
    
    res.json({ success: true });
});

// Delete gallery
app.delete('/api/galleries/:id', (req, res) => {
    const galleryId = req.params.id;
    const authHeader = req.headers['x-session-token'];
    
    const gallery = dbGet('SELECT * FROM galleries WHERE id = ?', [galleryId]);
    
    if (!gallery || authHeader !== gallery.admin_id) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Delete all photos
    const photos = dbAll('SELECT filename FROM photos WHERE gallery_id = ?', [galleryId]);
    photos.forEach(p => {
        const filePath = path.join(UPLOADS_DIR, p.filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    });
    
    dbRun('DELETE FROM photos WHERE gallery_id = ?', [galleryId]);
    dbRun('DELETE FROM galleries WHERE id = ?', [galleryId]);
    
    res.json({ success: true });
});

// Update gallery
app.patch('/api/galleries/:id', (req, res) => {
    const galleryId = req.params.id;
    const authHeader = req.headers['x-session-token'];
    
    const gallery = dbGet('SELECT * FROM galleries WHERE id = ?', [galleryId]);
    
    if (!gallery || authHeader !== gallery.admin_id) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const { coverPhoto, expiresColor, expiresAt, title, fontTitle, fontDate, titleColor, dateColor, titleOpacity, dateOpacity, coverPosition, titleSize, dateSize, borderRadius, showTitle, showDate } = req.body;
    
    const updates = [];
    const values = [];
    
    if (coverPhoto !== undefined) { updates.push('cover_photo = ?'); values.push(coverPhoto); }
    if (expiresColor !== undefined) { updates.push('expires_color = ?'); values.push(expiresColor); }
    if (expiresAt !== undefined) { updates.push('expires_at = ?'); values.push(expiresAt); }
    if (title !== undefined) { updates.push('title = ?'); values.push(title); }
    if (fontTitle !== undefined) { updates.push('font_title = ?'); values.push(fontTitle); }
    if (fontDate !== undefined) { updates.push('font_date = ?'); values.push(fontDate); }
    if (titleColor !== undefined) { updates.push('title_color = ?'); values.push(titleColor); }
    if (dateColor !== undefined) { updates.push('date_color = ?'); values.push(dateColor); }
    if (titleOpacity !== undefined) { updates.push('title_opacity = ?'); values.push(parseInt(titleOpacity)); }
    if (dateOpacity !== undefined) { updates.push('date_opacity = ?'); values.push(parseInt(dateOpacity)); }
    if (coverPosition !== undefined) { updates.push('cover_position = ?'); values.push(coverPosition); }
    if (titleSize !== undefined) { updates.push('title_size = ?'); values.push(titleSize); }
    if (dateSize !== undefined) { updates.push('date_size = ?'); values.push(dateSize); }
    if (borderRadius !== undefined) { updates.push('border_radius = ?'); values.push(borderRadius); }
    if (showTitle !== undefined) { updates.push('show_title = ?'); values.push(showTitle ? 1 : 0); }
    if (showDate !== undefined) { updates.push('show_date = ?'); values.push(showDate ? 1 : 0); }
    
    if (updates.length > 0) {
        values.push(galleryId);
        dbRun(`UPDATE galleries SET ${updates.join(', ')} WHERE id = ?`, values);
    }
    
    res.json({ success: true });
});

// Download ZIP
app.get('/api/gallery/:id/download', (req, res) => {
    const galleryId = req.params.id;
    const gallery = dbGet('SELECT title FROM galleries WHERE id = ?', [galleryId]);
    const photos = dbAll('SELECT filename, original_name FROM photos WHERE gallery_id = ? ORDER BY created_at ASC', [galleryId]);
    
    if (photos.length === 0) {
        return res.status(404).json({ error: 'No photos' });
    }
    
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="gallery.zip"');
    
    archive.pipe(res);
    
    photos.forEach((photo, i) => {
        const filePath = path.join(UPLOADS_DIR, photo.filename);
        if (fs.existsSync(filePath)) {
            const ext = path.extname(photo.original_name);
            archive.file(filePath, { name: `${String(i + 1).padStart(3, '0')}${ext}` });
        }
    });
    
    archive.finalize();
});

// Serve gallery page
app.get('/g/:id', (req, res) => {
    const gallery = dbGet('SELECT id, title, created_at, expires_at, cover_photo, expires_color, font_title, font_date, title_color, date_color, title_opacity, date_opacity, cover_position, title_size, date_size, border_radius, show_title, show_date FROM galleries WHERE id = ?', [req.params.id]);
    
    if (!gallery) {
        return res.status(404).send('<h1>Галерея не знайдена</h1>');
    }
    
    // Check if gallery is expired
    if (isGalleryExpired(gallery.expires_at)) {
        return res.status(410).send(`
            <h1>Галерея більше недоступна</h1>
            <p>Термін доступу до галереї "${gallery.title}" закінчився.</p>
            <p>Для продовження зв'яжіться з адміністратором.</p>
        `);
    }
    
    const photos = dbAll('SELECT id, filename, original_name, category_id FROM photos WHERE gallery_id = ? ORDER BY created_at ASC', [req.params.id]);
    
    const photoList = photos.map(p => ({
        id: p.id,
        url: `/uploads/${p.filename}`,
        name: p.original_name,
        category_id: p.category_id
    }));
    
    fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8', (err, html) => {
        if (err) return res.status(500).send('Error loading page');
        
        html = html.replace(/\{\{TITLE\}\}/g, gallery.title)
                   .replace(/\{\{DATE\}\}/g, '')
                   .replace(/\{\{EXPIRES\}\}/g, gallery.expires_at || '')
                   .replace(/\{\{GALLERY_ID\}\}/g, gallery.id)
                   .replace(/\{\{API_URL\}\}/g, '')
                   .replace(/\{\{COVER_PHOTO\}\}/g, gallery.cover_photo || '')
                   .replace(/\{\{EXPIRES_COLOR\}\}/g, gallery.expires_color || '#888888')
                   .replace(/\{\{TITLE_COLOR\}\}/g, gallery.title_color || '#ffffff')
                   .replace(/\{\{DATE_COLOR\}\}/g, gallery.date_color || '#ffffff')
                   .replace(/\{\{FONT_TITLE\}\}/g, gallery.font_title || 'Inter')
                   .replace(/\{\{FONT_DATE\}\}/g, gallery.font_date || 'Inter')
                   .replace(/\{\{COVER_POSITION\}\}/g, gallery.cover_position || 'center')
                   .replace(/\{\{TITLE_SIZE\}\}/g, gallery.title_size || 48)
                   .replace(/\{\{DATE_SIZE\}\}/g, gallery.date_size || 16)
                   .replace(/\{\{TITLE_OPACITY\}\}/g, (gallery.title_opacity || 100) / 100)
                   .replace(/\{\{DATE_OPACITY\}\}/g, (gallery.date_opacity || 100) / 100)
                   .replace(/\{\{BORDER_RADIUS\}\}/g, gallery.border_radius || 0)
                   .replace(/\{\{SHOW_TITLE\}\}/g, gallery.show_title ? 'block' : 'none')
                   .replace(/\{\{SHOW_DATE\}\}/g, gallery.show_date ? 'block' : 'none');
        
        html = html.replace('const photos = [];', `const photos = ${JSON.stringify(photoList)};`);
        
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    });
});

// Serve admin page
app.get('/admin', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

app.get('/admin/:adminId', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

// Start server
app.listen(PORT, async () => {
    await initDb();
    startCleanupScheduler();
    console.log(`Gallery service running on port ${PORT}`);
});
