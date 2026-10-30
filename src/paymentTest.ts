// Local-only payment demonstration. These orders do not represent real money or credits.
export type TestPaymentMethod='alipay'|'wechat';
export type TestOrderStatus='pending'|'success'|'cancelled';
type TestPackage={id:string;name:string;amountFen:number;credits:number};
export type TestOrder=Readonly<{id:string;packageId:string;method:TestPaymentMethod;status:TestOrderStatus;createdAt:number}>;

export const TEST_PACKAGES:ReadonlyArray<Readonly<TestPackage>>=Object.freeze([
 Object.freeze({id:'test-small',name:'体验包',amountFen:100,credits:10}),
 Object.freeze({id:'test-large',name:'进阶包',amountFen:300,credits:30}),
]);

const orders=new Map<string,TestOrder>();
let sequence=0;

export function createOrder(input:{packageId:string;method:TestPaymentMethod}):TestOrder{
 if(!input||typeof input!=='object'||!TEST_PACKAGES.some(item=>item.id===input.packageId))throw new Error('请选择测试套餐。');
 if(input.method!=='alipay'&&input.method!=='wechat')throw new Error('请选择测试支付方式。');
 const id=`test-${Date.now()}-${++sequence}`;
 const order=Object.freeze({id,packageId:input.packageId,method:input.method,status:'pending' as const,createdAt:Date.now()});
 orders.set(id,order);
 return order;
}

export function getOrder(orderId:string):TestOrder|null{
 return typeof orderId==='string'?orders.get(orderId)||null:null;
}

export function finishOrder(orderId:string,result:'success'|'cancelled'):TestOrder{
 const current=getOrder(orderId);
 if(!current)throw new Error('测试订单不存在。');
 if(result!=='success'&&result!=='cancelled')throw new Error('无效的测试订单状态。');
 if(current.status!=='pending')return current;
 const completed=Object.freeze({...current,status:result});
 orders.set(orderId,completed);
 return completed;
}
