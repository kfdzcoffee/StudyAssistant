// 确认门：AI 的每一个变更类工具调用，都先向渲染进程发起确认，等待用户同意/拒绝
// 同时支持「向用户提问并等待回答」（ask_user 工具），用于 AI 需要二次确认/补充信息时
class ConfirmGate {
  constructor(getWindow) {
    this.getWindow = getWindow;
    this._id = 0;
    this._pending = new Map();
  }

  init(ipcMain) {
    ipcMain.handle('confirm-response', (e, { id, approved, editedContent }) => {
      const resolve = this._pending.get(id);
      if (resolve) {
        this._pending.delete(id);
        resolve({ approved: !!approved, id, editedContent });
      }
      return true;
    });
    ipcMain.handle('ask-response', (e, { id, answer }) => {
      const resolve = this._pending.get(id);
      if (resolve) {
        this._pending.delete(id);
        const cancelled = answer === null || answer === undefined;
        resolve({ id, answer: cancelled ? '' : String(answer), cancelled });
      }
      return true;
    });
  }

  request({ tool, args, oldContent, newContent, target, summary }) {
    return new Promise((resolve) => {
      const id = ++this._id;
      this._pending.set(id, resolve);
      const w = this.getWindow();
      if (w && !w.isDestroyed()) {
        w.webContents.send('confirm-request', { id, tool, args, oldContent, newContent, target, summary });
      } else {
        return resolve({ approved: false, id });
      }
      // 超时自动拒绝（10 分钟），避免挂起
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          resolve({ approved: false, id, timeout: true });
        }
      }, 10 * 60 * 1000).unref();
    });
  }

  // 向用户提问并等待回答（AI 二次确认 / 补充信息）；返回 { answer, cancelled }
  ask({ question, options }) {
    return new Promise((resolve) => {
      const id = ++this._id;
      this._pending.set(id, resolve);
      const w = this.getWindow();
      if (w && !w.isDestroyed()) {
        w.webContents.send('ask-request', { id, question: question || '', options: options || [] });
      } else {
        this._pending.delete(id);
        return resolve({ answer: '', cancelled: true, id });
      }
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          resolve({ answer: '', cancelled: true, id, timeout: true });
        }
      }, 10 * 60 * 1000).unref();
    });
  }
}

module.exports = ConfirmGate;
