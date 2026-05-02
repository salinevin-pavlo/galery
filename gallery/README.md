# 🖼️ Gallery Service

Самописний аналог Gallera.io — фото-галерея з адмін-панеллю.

## Можливості

- ✅ Галерея доступна за посиланням
- ✅ Скачування окремих фото або всіх разом (ZIP)
- ✅ Адмін-панель для завантаження фото
- ✅ Пароль для керування галереєю
- ✅ Зберігання 30 днів (автовидалення)
- ✅ Безкоштовний хостинг

## Швидкий старт

### Варіант 1: Render.com (найпростіше)

1. Створи акаунт на [render.com](https://render.com)
2. Натисни **New → Web Service**
3. Підключи GitHub репозиторій
4. Вибери:
   - **Root Directory:** `gallery`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. Додай Environment variable: `PORT = 3000`
6. Натисни **Create Web Service**

Через ~2 хвилини отримаєш посилання типу `https://твоє-ім'я.onrender.com`

---

### Варіант 2: Railway

1. Створи акаунт на [railway.app](https://railway.app)
2. **New Project → Deploy from GitHub**
3. Вибери репозиторій
4. Railway автоматично задеплоїть

---

### Варіант 3: Fly.io

```bash
# Встанови flyctl
curl -L https://fly.io/install.sh | sh

# Логін
fly auth login

# Деплой
cd gallery
fly launch --image node:22-alpine --no-input
fly deploy
```

---

### Варіант 4: Docker на своєму сервері

```bash
cd gallery
docker build -t gallery .
docker run -d -p 3000:3000 \
  -v ./data:/app/data \
  -v ./uploads:/app/uploads \
  gallery
```

---

## Використання

### Створення галереї

1. Відкрий `https://твій-сервер/admin`
2. Введи назву та пароль
3. Отримай посилання на галерею

### Завантаження фото

1. Перейди за посиланням адмін-панелі
2. Перетягни фото у зону завантаження
3. Готово!

### Перегляд галереї

1. Перейди за посиланням `https://твій-сервер/g/ID`
2. Клік на фото — відкривається лайтбокс
3. Кнопка "Скачати всі фото" — ZIP архів

---

## Структура

```
gallery/
├── server.js          # Express сервер
├── public/
│   ├── index.html    # Сторінка перегляду
│   └── admin.html    # Адмін-панель
├── data/             # SQLite база (автозаповнюється)
├── uploads/          # Фото (автозаповнюється)
└── package.json
```

---

## API

| Метод | Endpoint | Опис |
|-------|----------|------|
| POST | `/api/galleries` | Створити галерею |
| POST | `/api/admin/login` | Логін адміна |
| GET | `/api/gallery/:id` | Отримати дані галереї |
| POST | `/api/gallery/:id/photos` | Завантажити фото |
| DELETE | `/api/gallery/:id/photos/:photoId` | Видалити фото |
| GET | `/api/gallery/:id/download` | Скачати всі фото (ZIP) |

---

## Вартість хостингу

| Платформа | Free Tier | Ліміти |
|------------|-----------|--------|
| Render | 750 годин/місяць | Спить після 15 хв без активності |
| Railway | $5/місяць free credits | ~500 годин |
| Fly.io | 3 апки безкоштовно | 160GB RAM |

Рекомендую **Render.com** — найпростіше і безкоштовно поки не превищиш 750 год/місяць.
