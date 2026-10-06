import unittest
from worker import route_for
class RoutingTests(unittest.TestCase):
    def test_sales_default(self):
        self.assertEqual(route_for('Lifetime sales for Gundersen Lutheran Hospital').key, 'cfo')
    def test_chart_email_uses_current_caller_context(self):
        context=[{'speaker':'remote','text':'What was my last email?'},{'speaker':'remote','text':'Lifetime sales for Gundersen Lutheran, monthly cases and moving averages'}]
        self.assertEqual(route_for('And email it to me',context).key,'cfo')
    def test_new_email_topic_not_old_sales(self):
        context=[{'speaker':'remote','text':'Hospital sales'},{'speaker':'remote','text':'Summarize my latest email'}]
        self.assertEqual(route_for('Email it to me',context).key,'admin')
    def test_research_no_longer_dropped(self):
        self.assertEqual(route_for('When is SAGES in 2027?').key,'research')
    def test_surgeon_sales_and_social_ignored(self):
        self.assertEqual(route_for('Find surgeon Gersin in North Carolina').key,'sales')
        self.assertIsNone(route_for('Thanks, perfect'))
if __name__=='__main__': unittest.main()
