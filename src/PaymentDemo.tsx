import React, {useState} from 'react';
import {createOrder, finishOrder, TEST_PACKAGES} from './paymentTest';
import './PaymentDemo.css';

type Stage = 'choose' | 'checkout' | 'success' | 'cancelled';
type Channel = 'wechat' | 'alipay';

/** Local-only payment flow demo. No money or actual generation credits change. */
export function PaymentDemo({onClose}: {onClose: () => void}) {
  const [stage, setStage] = useState<Stage>('choose');
  const [planId, setPlanId] = useState('test-small');
  const [channel, setChannel] = useState<Channel>('wechat');
  const [orderId, setOrderId] = useState<string|null>(null);
  const [error, setError] = useState('');
  const plan = TEST_PACKAGES.find(item => item.id === planId) || TEST_PACKAGES[0];
  const channelName = channel === 'wechat' ? '微信支付' : '支付宝';

  function startCheckout() {
    try {
      const order = createOrder({packageId: planId, method: channel});
      setOrderId(order.id); setError(''); setStage('checkout');
    } catch { setError('无法创建测试订单，请重试。'); }
  }
  function completeCheckout(result:'success'|'cancelled') {
    try {
      if (!orderId) throw new Error('Missing order');
      const order = finishOrder(orderId, result);
      if (order.status === 'pending') throw new Error('Pending order');
      setError(''); setStage(order.status);
    } catch { setError('无法更新测试订单，请重试。'); }
  }

  const heading = stage === 'choose' ? '模拟购买次数' : stage === 'checkout' ? '模拟收银台' : stage === 'success' ? '模拟支付成功' : '已取消模拟支付';
  return <section className="payment-demo">
    <header className="payment-demo-header">
      <button type="button" data-initial-focus className="payment-demo-back" onClick={onClose} aria-label="关闭模拟付款">×</button>
      <span>付款流程测试</span><span aria-hidden="true" className="payment-demo-header-space" />
    </header>
    <div className="payment-demo-body">
      <div className="payment-demo-badge">模拟测试</div>
      <h2 id="payment-demo-title">{heading}</h2>
      <p className="payment-demo-intro">仅用于体验流程，不会真实扣款，也不会增加生图次数。</p>
      {stage === 'choose' && <>
        <fieldset className="payment-demo-fieldset"><legend>选择示例套餐</legend>
          <div className="payment-demo-plans">{TEST_PACKAGES.map(item => <button key={item.id} type="button" className="payment-demo-plan" aria-pressed={planId === item.id} onClick={() => setPlanId(item.id)}>
            <strong>{item.name}</strong><span>{item.credits} 次 · 示例</span><b>¥{(item.amountFen / 100).toFixed(2)}</b>
          </button>)}</div>
        </fieldset>
        <fieldset className="payment-demo-fieldset"><legend>选择支付方式</legend>
          <div className="payment-demo-channels">
            <button type="button" aria-pressed={channel === 'wechat'} onClick={() => setChannel('wechat')}><span className="payment-demo-channel-icon wechat" aria-hidden="true">微</span>微信支付 <span className="payment-demo-selected" aria-hidden="true">{channel === 'wechat' ? '✓' : ''}</span></button>
            <button type="button" aria-pressed={channel === 'alipay'} onClick={() => setChannel('alipay')}><span className="payment-demo-channel-icon alipay" aria-hidden="true">支</span>支付宝 <span className="payment-demo-selected" aria-hidden="true">{channel === 'alipay' ? '✓' : ''}</span></button>
          </div>
        </fieldset>
        <button type="button" className="payment-demo-primary" onClick={startCheckout}>进入模拟收银台</button>
      </>}
      {stage === 'checkout' && <div className="payment-demo-checkout">
        <div className="payment-demo-order"><span>{plan.name} · {plan.credits} 次（示例）</span><strong>¥{(plan.amountFen / 100).toFixed(2)}</strong><small>支付方式：{channelName}（模拟）</small></div>
        <p>这里模拟第三方收银台，未连接任何支付平台。</p>
        <button type="button" className="payment-demo-primary" onClick={() => completeCheckout('success')}>模拟支付成功</button>
        <button type="button" className="payment-demo-secondary" onClick={() => completeCheckout('cancelled')}>模拟取消</button>
      </div>}
      {(stage === 'success' || stage === 'cancelled') && <div className="payment-demo-result" role="status">
        <span className="payment-demo-result-icon" aria-hidden="true">{stage === 'success' ? '✓' : '−'}</span>
        <p>{stage === 'success' ? '已走完示例付款流程。没有发生扣款或到账。' : '本次模拟订单已取消，没有发生扣款。'}</p>
        <button type="button" className="payment-demo-primary" onClick={() => setStage('choose')}>重新测试</button>
        <button type="button" className="payment-demo-secondary" onClick={onClose}>返回创作</button>
      </div>}
      {error && <p role="alert" className="payment-demo-error">{error}</p>}
    </div>
  </section>;
}
