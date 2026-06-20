# 🔴 Red Shop — Telegram Mini App

Магазин одноразовых сигарет с Telegram Mini App интерфейсом.

## Структура проекта

```
miniap/
├── server.js           # Express сервер + Telegram бот
├── package.json
├── .env                # Настройки (создай из .env.example)
├── .env.example
├── public/
│   ├── index.html      # Главная страница Mini App
│   ├── style.css       # Стили (чёрно-красная тема)
│   ├── app.js          # Вся логика фронтенда
│   ├── uploads/        # Загруженные фото товаров
│   └── img/
│       ├── logo.svg
│       └── placeholder.svg
└── data/
    ├── products.json   # Товары
    ├── orders.json     # Заказы
    ├── users.json      # Пользователи
    └── messages.json   # Сообщения
```

## Быстрый старт

### 1. Установка зависимостей
```bash
npm install
```

### 2. Создание Telegram бота

1. Открой [@BotFather](https://t.me/botfather) в Telegram
2. Создай бота: `/newbot`
3. Скопируй токен
4. Настрой Mini App: `/newapp` → выбери бота → укажи URL сервера

### 3. Настройка .env

Скопируй `.env.example` в `.env` и заполни:

```env
BOT_TOKEN=123456789:ABCdef...     # Токен бота от BotFather
WEBAPP_URL=https://your-domain.com # URL вашего сервера (HTTPS!)
ADMIN_IDS=123456789,987654321      # Твои Telegram ID (узнать у @userinfobot)
ADMIN_PASS_1=RedAdmin_2024         # Пароль 1-го администратора
ADMIN_PASS_2=RedShop_Boss          # Пароль 2-го администратора
PORT=3000
```

### 4. Запуск

```bash
# Продакшен
npm start

# Разработка (с авто-перезапуском)
npm run dev
```

## Деплой на сервер

Telegram Mini App **требует HTTPS**. Используйте:

- [Railway](https://railway.app) — бесплатно, просто
- [Render](https://render.com) — бесплатный тир
- [VPS + nginx + certbot] — для контроля

### Пример деплоя на Railway:
1. Загрузи код на GitHub
2. Создай новый проект на Railway
3. Подключи репозиторий
4. Добавь переменные окружения в Railway Dashboard
5. Скопируй URL (вида `xxx.railway.app`) в `WEBAPP_URL`

## Функционал

### Магазин (покупатели)
- 📦 Каталог вкусов с фото, названием и ценой
- 🛒 Корзина с управлением количеством
- 🎰 Рулетка скидок (1 раз в день):
  - 50 сом — вероятность 75%
  - 100 сом — вероятность 15%
  - 150 сом — вероятность 10%
- ✅ Оформление заказа через Telegram бот

### Админ панель (пароль-защита)
- **Товары**: добавить/удалить/изменить цену/фото/наличие
- **Заказы**: список с фильтрами, смена статуса (Новый → В обработке → Выполнен)
- **Сообщения**: просмотр чатов с покупателями, ответы прямо из панели
- **Рассылка**: отправить текст + фото всем пользователям
- **Статистика**: пользователи, заказы сегодня, продажи, топ вкусов

## Пароли по умолчанию

Измени в `.env` перед запуском!

- Администратор 1: `RedAdmin_2024`
- Администратор 2: `RedShop_Boss`

## Технологии

- **Backend**: Node.js, Express, node-telegram-bot-api
- **Frontend**: Vanilla JS, HTML5 Canvas (рулетка), CSS3
- **Хранилище**: JSON файлы (для масштабирования замените на PostgreSQL/MongoDB)
- **Интеграция**: Telegram Web App API
