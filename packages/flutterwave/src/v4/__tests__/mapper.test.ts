import { describe, expect, it } from 'vitest';
import {
  toFlutterwaveName,
  toFlutterwavePhone,
  toRefundReason,
} from '../utils/mapper';

describe('toFlutterwavePhone', () => {
  it.each([
    ['+2349067985861', '234', '9067985861'],
    ['+233201234567', '233', '201234567'],
    ['+254712345678', '254', '712345678'],
    ['+27821234567', '27', '821234567'],
    ['+447911123456', '44', '7911123456'],
    ['+14155552671', '1', '4155552671'],
    ['+79161234567', '7', '9161234567'],
    ['+20 100 123 4567', '20', '1001234567'],
    ['+234 (906) 798-5861', '234', '9067985861'],
  ])('splits %s', (input, country_code, number) => {
    expect(toFlutterwavePhone(input)).toEqual({
      country_code,
      number,
    });
  });

  it.each([
    '09067985861',
    '2349067985861',
    '+0123456789',
    '+12',
    'abc',
  ])('rejects %s', input => {
    expect(toFlutterwavePhone(input)).toBeNull();
  });
});

describe('toFlutterwaveName', () => {
  it.each([
    ['King', { first: 'King' }],
    ['King James', { first: 'King', last: 'James' }],
    [
      'King Leo James',
      { first: 'King', middle: 'Leo', last: 'James' },
    ],
    [
      'Ada Mary Jane Obi',
      { first: 'Ada', middle: 'Mary Jane', last: 'Obi' },
    ],
    ['  King   James ', { first: 'King', last: 'James' }],
  ])('splits %j', (input, expected) => {
    expect(toFlutterwaveName(input)).toEqual(expected);
  });
});

describe('toRefundReason', () => {
  it('passes a valid reason through', () => {
    expect(toRefundReason('fraudulent')).toEqual({
      reason: 'fraudulent',
    });
  });

  it('falls back and keeps free text as a note', () => {
    expect(toRefundReason('Changed their mind')).toEqual({
      reason: 'requested_by_customer',
      note: 'Changed their mind',
    });
  });

  it('falls back without a note when there is no reason', () => {
    expect(toRefundReason(null)).toEqual({
      reason: 'requested_by_customer',
    });
  });
});
