'use strict';
/**
 * test_calc.js — 计算器用例（含安全边界：注入 / 非法字符 / 极值）
 * 运行：node test_calc.js
 */
const { calculate } = require('./tools/calc');

let pass = 0, fail = 0;
const failures = [];
function eq(name, expr, expected) {
  const r = calculate(expr);
  const ok = r.ok && Math.abs(r.value - expected) < 1e-9;
  if (ok) pass++;
  else { fail++; failures.push(`${name}: ${expr} → ${JSON.stringify(r)} 期望 ${expected}`); }
  console.log(`${ok ? '✓' : '✗'} ${name}: ${expr} = ${r.ok ? r.display : 'ERR ' + r.error}`);
}
function bad(name, expr) {
  const r = calculate(expr);
  const ok = !r.ok;
  if (ok) pass++; else { fail++; failures.push(`${name}: 应拒绝 ${expr}，却得到 ${r.value}`); }
  console.log(`${ok ? '✓' : '✗'} ${name}: ${expr} → ${r.ok ? '未拒绝 ' + r.display : '已拒绝 ' + r.error}`);
}

console.log('[1] 基本运算');
eq('加法', '1+2', 3);
eq('优先级', '2+3*4', 14);
eq('括号', '(2+3)*4', 20);
eq('减法负数', '5-8', -3);
eq('除法', '7/2', 3.5);
eq('取余', '7%3', 1);
eq('幂', '2^10', 1024);
eq('幂右结合', '2^3^2', 512);
eq('一元负', '-3^2', -9);
eq('小数', '0.1+0.2', 0.3);
eq('大数', '99999*99999', 9999800001);
eq('全角运算符', '3×4÷2', 6);
eq('中文减号', '10−4', 6);

console.log('\n[2] 函数与常量');
eq('开方', 'sqrt(144)', 12);
eq('绝对值', 'abs(-5)', 5);
eq('四舍五入', 'round(3.14159,2)', 3.14);
eq('取整', 'floor(3.9)', 3);
eq('最大值', 'max(3,7,2)', 7);
eq('嵌套函数', 'sqrt(pow(3,2)+pow(4,2))', 5);
eq('圆周率', 'pi', Math.PI);
eq('自然对数底', 'e', Math.E);
eq('组合', 'round(pi*2,3)', 6.283);
eq('中文场景', 'round(199*0.85,2)', 169.15);

console.log('\n[3] 安全边界（必须拒绝）');
bad('代码注入', '__import__("os")');
bad('函数调用注入', 'process.exit(1)');
bad('构造器逃逸', 'constructor.constructor("return 1")()');
bad('非法字符', '1 + alert(1)');
bad('字符串', '"hello"');
bad('未知标识符', 'foo(1)');
bad('不支持函数', 'eval(1)');
bad('除零', '1/0');
bad('括号不匹配', '(1+2');
bad('多余内容', '1+2 3');
bad('空表达式', '  ');
bad('超长表达式', '1+'.repeat(120) + '1');
bad('嵌套过深', '('.repeat(40) + '1' + ')'.repeat(40));

console.log('\n[4] 结果格式');
{
  const r = calculate('1/3');
  const ok = r.ok && r.display === '0.333333333333';
  if (ok) pass++; else { fail++; failures.push('1/3 显示: ' + (r.ok ? r.display : r.error)); }
  console.log(`${ok ? '✓' : '✗'} 1/3 → ${r.ok ? r.display : r.error}`);
}

console.log(`\n通过: ${pass}  失败: ${fail}`);
if (fail) { console.log('失败项:'); failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
console.log('全部通过 ✓');
