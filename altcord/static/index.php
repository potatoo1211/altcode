<?php
/**
 * Altcord - PHP entry point
 *
 * This file serves the Altcord UI and can be used in place of (or alongside)
 * index.html when the directory is hosted via XAMPP or a PHP-capable server.
 *
 * The HTML is output verbatim from this file so that:
 *   1. All asset paths (css/, js/, default_avatar.png) remain relative.
 *   2. The FastAPI backend (/api/* and /ws) is referenced via the configured
 *      BASE_API_URL variable injected into the page at load time.
 *
 * Environment / configuration
 * ----------------------------
 * Set ALTCORD_API_URL in the web-server environment (or in a .env.php file)
 * to point at the running FastAPI server.  Defaults to http://localhost:8000
 */

// ---------- configuration ----------
// When served via XAMPP with .htaccess proxy, leave empty to use relative /api/* paths.
// Set ALTCORD_API_URL env var to an absolute URL only when serving the UI from a different origin.
$api_url = getenv('ALTCORD_API_URL') ?: '';

// Strip trailing slash for consistency
$api_url = rtrim($api_url, '/');

// ---------- output HTML ----------
header('Content-Type: text/html; charset=UTF-8');
?>
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>💬</text></svg>">
  <title>Altcord</title>
  <link rel="stylesheet" href="css/style.css?v6.0">
  <link rel="stylesheet" href="css/mobile.css?v6.0">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <script>
    /* Injected by index.php – used by app.js to locate the backend */
    window.ALTCORD_API_URL = <?= json_encode($api_url) ?>;
  </script>
</head>
<body class="theme-dark">
  <!-- トースト通知コンテナ -->
  <div class="toast-container" id="toast-container"></div>

  <div class="mobile-drawer-backdrop" id="mobile-drawer-backdrop"></div>
  <div id="app-container">
    
    <!-- 1. サーバーリスト (一番左のバー) -->
    <nav class="guilds-nav" id="guilds-nav">
      <div class="guild-item home-btn active" id="home-btn" title="Altcord Direct Messages">
        <div class="pill"></div>
        <div class="guild-icon">
          <i class="fa-brands fa-discord"></i>
        </div>
      </div>
      <div class="guild-separator"></div>
      <div class="guild-list" id="guild-list">
        <!-- 動的にDiscordサーバーアイコンが入る -->
      </div>
    </nav>

    <!-- 2. チャンネルサイドバー -->
    <aside class="sidebar" id="sidebar">
      <header class="guild-header" id="guild-header">
        <span class="guild-name" id="guild-name-display">Altcord</span>
        <i class="fa-solid fa-chevron-down guild-dropdown-icon"></i>
      </header>

      <div class="channels-scroller" id="channels-scroller">
        <!-- 動的にカテゴリとチャンネルが入る -->
      </div>

      <!-- ユーザー情報パネル (左下) -->
      <footer class="user-panel" id="user-panel">
        <div class="user-avatar-wrap" id="user-avatar-wrap" title="クリックしてステータスを変更">
          <img src="default_avatar.png" alt="Avatar" id="my-avatar" class="user-avatar">
          <div class="status-indicator online" id="my-status-indicator"></div>

          <!-- ステータス選択メニュー -->
          <div class="status-picker-menu" id="status-picker-menu" style="display: none;">
            <div class="status-opt active" data-status="online">
              <div class="status-indicator online" style="position: static; width: 10px; height: 10px;"></div>
              <span>オンライン (通知 ON)</span>
            </div>
            <div class="status-opt" data-status="dnd">
              <div class="status-indicator dnd" style="position: static; width: 10px; height: 10px;"></div>
              <span>取り込み中 (通知 OFF)</span>
            </div>
          </div>
        </div>
        <div class="user-info-text">
          <div class="user-nickname" id="my-nickname">ユーザー名</div>
          <div class="user-username" id="my-username">@userid</div>
        </div>
        <div class="user-actions">
          <button class="icon-btn" id="btn-toggle-mic" title="マイクミュート"><i class="fa-solid fa-microphone"></i></button>
          <button class="icon-btn" id="btn-toggle-sound" title="通知音ミュート切替"><i class="fa-solid fa-headphones"></i></button>
          <button class="icon-btn" id="btn-open-settings" title="ユーザー設定"><i class="fa-solid fa-gear"></i></button>
        </div>
      </footer>
    </aside>

    <!-- 3. メインチャットエリア -->
    <main class="chat-main" id="chat-main">
      <!-- チャンネルヘッダー -->
      <header class="chat-header">
        <div class="header-left">
          <button class="mobile-menu-btn" id="btn-mobile-channels" title="チャンネル一覧"><i class="fa-solid fa-bars"></i></button>
          <i class="fa-solid fa-hashtag header-channel-icon" id="header-icon"></i>
          <span class="header-channel-name" id="header-channel-name">チャンネルを選択してください</span>
          <div class="header-divider"></div>
          <span class="header-channel-topic" id="header-channel-topic"></span>
        </div>

        <div class="header-right">
          <!-- 検索バー -->
          <div class="search-bar-wrap">
            <div class="search-input-box">
              <input type="text" id="search-input" placeholder="検索" autocomplete="off">
              <i class="fa-solid fa-magnifying-glass search-icon" id="btn-trigger-search"></i>
              <i class="fa-solid fa-xmark search-clear-icon" id="btn-clear-search" style="display: none;"></i>
            </div>
            <!-- 検索サジェストポップアップ -->
            <div class="search-dropdown" id="search-dropdown" style="display: none;">
              <div class="search-dropdown-title">検索オプション</div>
              <div class="search-opt-item" data-filter="from:"><span class="opt-key">from:</span> <span class="opt-desc">ユーザーで絞り込み</span></div>
              <div class="search-opt-item" data-filter="has:image"><span class="opt-key">has:image</span> <span class="opt-desc">画像を含む投稿</span></div>
              <div class="search-opt-item" data-filter="has:video"><span class="opt-key">has:video</span> <span class="opt-desc">動画を含む投稿</span></div>
              <div class="search-opt-item" data-filter="has:file"><span class="opt-key">has:file</span> <span class="opt-desc">ファイル添付を含む投稿</span></div>
              <div class="search-opt-item" data-filter="has:link"><span class="opt-key">has:link</span> <span class="opt-desc">リンクを含む投稿</span></div>
              <div class="search-opt-item" data-filter="in:"><span class="opt-key">in:</span> <span class="opt-desc">チャンネルで絞り込み</span></div>
              <div class="search-opt-item" data-filter="before:"><span class="opt-key">before:</span> <span class="opt-desc">指定日以前 (YYYY-MM-DD)</span></div>
              <div class="search-opt-item" data-filter='""'><span class="opt-key">"完全一致"</span> <span class="opt-desc">クォーテーションで囲んで完全一致</span></div>
            </div>
          </div>

          <button class="header-icon-btn" id="btn-toggle-members" title="メンバーリスト"><i class="fa-solid fa-users"></i></button>
        </div>
      </header>

      <!-- チャット本体コンテナ (中央チャット + 右サイドバー) -->
      <div class="chat-body-container">
        
        <!-- 中央カラム: メッセージ履歴 + チャット入力欄 (入力欄がメンバー側へ貫通しない構造) -->
        <div class="chat-center-column" style="position: relative;">
          <!-- ファイルドラッグ＆ドロップ オーバーレイ -->
          <div class="file-drop-overlay" id="file-drop-overlay" style="display: none;">
            <i class="fa-solid fa-cloud-arrow-up drop-overlay-icon"></i>
            <div class="drop-overlay-text">ファイルをここにドロップして添付</div>
          </div>
          <div class="messages-wrap" id="messages-wrap">
            <!-- 上部インジケーター (過去ログ読み込み中スピナー) -->
            <div class="history-loader" id="history-loader" style="display: none;">
              <div class="spinner"></div>
              <span>過去のメッセージを読み込み中...</span>
            </div>

            <div class="channel-welcome-banner" id="channel-welcome" style="display: none;">
              <div class="welcome-icon"><i class="fa-solid fa-hashtag"></i></div>
              <h2 class="welcome-title" id="welcome-title">ようこそ！</h2>
              <p class="welcome-desc" id="welcome-desc">ここがチャンネルの始まりです。</p>
            </div>

            <!-- メッセージリスト -->
            <div class="messages-list" id="messages-list">
              <div class="placeholder-text">チャンネルを選択するとメッセージが表示されます</div>
            </div>
          </div>

          <!-- 入力エリア -->
          <div class="chat-input-area">
            <!-- メンション/サジェスト パネル (@, #, :, from:, in:) -->
            <div class="autocomplete-panel" id="autocomplete-panel" style="display: none;"></div>
            <!-- 絵文字・スタンプ ピッカー パネル -->
            <div class="emoji-picker-panel" id="emoji-picker-panel" style="display: none;">
              <div class="ep-tabs">
                <button type="button" class="ep-tab active" data-tab="emoji"><i class="fa-regular fa-face-smile"></i> 絵文字</button>
                <button type="button" class="ep-tab" data-tab="sticker"><i class="fa-solid fa-note-sticky"></i> スタンプ</button>
              </div>
              <div class="ep-body" id="ep-body"></div>
            </div>

            <!-- リプライ対象プレビューバー -->
            <div class="reply-bar" id="reply-bar" style="display: none;">
              <i class="fa-solid fa-reply"></i>
              <span class="reply-to-text" id="reply-to-text">Replying to ...</span>
              <button class="reply-close-btn" id="btn-cancel-reply"><i class="fa-solid fa-xmark"></i></button>
            </div>

            <!-- 添付ファイルプレビューバー -->
            <div class="attachment-preview-bar" id="attachment-preview-bar" style="display: none;"></div>

            <form class="chat-form" id="chat-form">
              <input type="file" id="file-input" multiple accept="image/*,video/*,audio/*,.pdf,.zip,.txt,.doc,.docx" style="display: none;">
              <button type="button" class="upload-btn" id="btn-upload" title="ファイルを添付">
                <i class="fa-solid fa-circle-plus"></i>
              </button>

              <div id="message-input" contenteditable="true" role="textbox" placeholder="メッセージを送信"></div>

              <button type="button" class="upload-btn" id="btn-emoji-picker" title="絵文字・スタンプ">
                <i class="fa-regular fa-face-smile"></i>
              </button>

              <button type="submit" class="send-btn" id="btn-send" title="送信">
                <i class="fa-solid fa-paper-plane"></i>
              </button>
            </form>
          </div>
        </div>

        <!-- メンバーリスト (右側サイドバー) -->
        <aside class="members-sidebar" id="members-sidebar">
          <div class="members-scroller" id="members-scroller">
            <!-- 動的にロール別にグループ化されたメンバーが入る -->
          </div>
        </aside>

        <!-- 検索結果パネル (検索時に展開) -->
        <aside class="search-results-sidebar" id="search-results-sidebar" style="display: none;">
          <header class="search-results-header">
            <span class="search-count" id="search-results-count">0 件の結果</span>
            <button class="icon-btn" id="btn-close-search"><i class="fa-solid fa-xmark"></i></button>
          </header>
          <div class="search-results-list" id="search-results-list">
            <!-- 検索結果アイテム -->
          </div>
        </aside>

      </div>
    </main>

  </div>

  <!-- ログイン / 新規登録モーダル -->
  <div class="modal-overlay" id="auth-modal" style="display: flex;">
    <div class="auth-card">
      <div class="auth-tabs">
        <button class="auth-tab active" id="tab-login">ログイン</button>
        <button class="auth-tab" id="tab-register">新規登録</button>
      </div>

      <!-- ログインフォーム -->
      <form id="form-login" class="auth-form">
        <h3 class="auth-title">おかえりなさい！</h3>
        <p class="auth-subtitle">Altcord で Discord の世界へ接続しましょう</p>
        
        <div class="form-group">
          <label>ユーザーID <span class="required">*</span></label>
          <input type="text" id="login-username" required autocomplete="username">
        </div>

        <div class="form-group">
          <label>パスワード <span class="required">*</span></label>
          <input type="password" id="login-password" required autocomplete="current-password">
        </div>

        <div class="form-error" id="login-error"></div>
        <button type="submit" class="btn-primary auth-submit-btn">ログイン</button>
      </form>

      <!-- 新規登録フォーム -->
      <form id="form-register" class="auth-form" style="display: none;">
        <h3 class="auth-title">アカウントを作成</h3>
        <p class="auth-subtitle">ID、ニックネーム、アイコンを設定できます</p>

        <div class="form-group">
          <label>ユーザーID (英数字) <span class="required">*</span></label>
          <input type="text" id="reg-username" required autocomplete="username">
        </div>

        <div class="form-group">
          <label>ニックネーム (表示名)</label>
          <input type="text" id="reg-nickname" placeholder="未入力時はユーザーID">
        </div>

        <div class="form-group">
          <label>パスワード <span class="required">*</span></label>
          <input type="password" id="reg-password" required autocomplete="new-password">
        </div>

        <div class="form-group">
          <label>アイコン画像</label>
          <div class="avatar-select-row">
            <img src="default_avatar.png" id="reg-avatar-preview" class="reg-avatar-thumb">
            <button type="button" class="btn-secondary" id="btn-reg-avatar-pick">画像を選択・編集</button>
            <input type="file" id="reg-avatar" accept="image/*" style="display: none;">
          </div>
        </div>

        <div class="form-error" id="reg-error"></div>
        <button type="submit" class="btn-primary auth-submit-btn">アカウント作成</button>
      </form>
    </div>
  </div>

  <!-- プロフィール設定モーダル -->
  <div class="modal-overlay" id="profile-modal" style="display: none;">
    <div class="profile-card">
      <div class="profile-header">
        <h3>ユーザープロフィール設定</h3>
        <button class="icon-btn" id="btn-close-profile"><i class="fa-solid fa-xmark"></i></button>
      </div>

      <form id="form-profile" class="profile-form">
        <div class="avatar-edit-section">
          <img src="default_avatar.png" id="profile-avatar-preview" class="profile-large-avatar">
          <div>
            <button type="button" class="btn-secondary" id="btn-profile-avatar-pick">アイコン画像を変更・編集</button>
            <input type="file" id="profile-avatar-input" accept="image/*" style="display: none;">
          </div>
        </div>

        <div class="form-group">
          <label>ユーザーID</label>
          <input type="text" id="profile-userid" disabled>
        </div>

        <div class="form-group">
          <label>ニックネーム (Discord投稿時に表示)</label>
          <input type="text" id="profile-nickname" required>
        </div>

        <div class="form-actions">
          <button type="button" class="btn-secondary" id="btn-logout" style="color: #ed4245;">ログアウト</button>
          <button type="submit" class="btn-primary">保存する</button>
        </div>
      </form>
    </div>
  </div>

  <!-- 本家Discord風 アイコン編集・拡大縮小・トリミングモーダル -->
  <div class="modal-overlay" id="avatar-crop-modal" style="display: none;">
    <div class="crop-card">
      <div class="crop-header">
        <h3>アイコンを編集</h3>
        <button class="icon-btn" id="btn-close-cropper"><i class="fa-solid fa-xmark"></i></button>
      </div>

      <div class="crop-viewport-container">
        <div class="crop-viewport" id="crop-viewport">
          <img src="" id="crop-image" alt="Crop Target">
          <div class="crop-mask-circle"></div>
        </div>
      </div>

      <div class="crop-controls">
        <i class="fa-solid fa-image" style="font-size: 14px; color: var(--text-muted);"></i>
        <input type="range" id="crop-zoom-range" min="1" max="3" step="0.01" value="1">
        <i class="fa-solid fa-image" style="font-size: 20px; color: var(--text-muted);"></i>
      </div>

      <div class="crop-actions">
        <button type="button" class="btn-secondary" id="btn-crop-cancel">キャンセル</button>
        <button type="button" class="btn-primary" id="btn-crop-apply">適用する</button>
      </div>
    </div>
  </div>

  <!-- 画像拡大ライトボックス -->
  <div class="lightbox-overlay" id="lightbox-modal" style="display: none;">
    <img src="" id="lightbox-img" class="lightbox-img">
    <button class="lightbox-close" id="btn-close-lightbox"><i class="fa-solid fa-xmark"></i></button>
  </div>

  <script src="js/app.js?v6.0"></script>
</body>
</html>
