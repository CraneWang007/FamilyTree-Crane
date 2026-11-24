/* 家和万事兴 · 登录 / 注册 */
(function () {
  const $ = id => document.getElementById(id);
  let mode = 'login';

  const tabBtns = document.querySelectorAll('.auth-tabs button');
  const displayField = $('displayNameField');
  const submitBtn = $('submitBtn');
  const tip = $('authTip');

  function setMode(next) {
    mode = next;
    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === next));
    displayField.classList.toggle('hidden', next !== 'register');
    submitBtn.textContent = next === 'login' ? '登录' : '注册并登录';
    tip.textContent = '';
  }

  tabBtns.forEach(b => b.addEventListener('click', () => setMode(b.dataset.tab)));

  async function api(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || '请求失败');
    return data.data;
  }

  $('authForm').addEventListener('submit', async e => {
    e.preventDefault();
    const username = $('f_username').value.trim();
    const password = $('f_password').value;
    const display_name = $('f_display_name').value.trim();
    if (!username || !password) { tip.textContent = '请填写用户名与密码'; tip.classList.add('err'); return; }
    tip.classList.remove('err');
    tip.textContent = '处理中…';
    try {
      if (mode === 'register') {
        await api('/api/auth/register', { username, password, display_name });
      }
      const data = await api('/api/auth/login', { username, password });
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      window.location.href = '/home';
    } catch (err) {
      tip.textContent = err.message;
      tip.classList.add('err');
    }
  });

  // 微信登录：小程序端传真实 code；Web 开发环境未配置 AppID 时为模拟登录
  $('wechatBtn').addEventListener('click', async () => {
    const code = $('f_wechat_code').value.trim();
    const wtip = $('wechatTip');
    if (!code) { wtip.textContent = '请输入微信登录 code'; wtip.classList.add('err'); return; }
    wtip.classList.remove('err');
    wtip.textContent = '微信登录中…';
    try {
      const data = await api('/api/auth/wechat/login', { code });
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      window.location.href = '/home';
    } catch (err) {
      wtip.textContent = err.message;
      wtip.classList.add('err');
    }
  });
})();
